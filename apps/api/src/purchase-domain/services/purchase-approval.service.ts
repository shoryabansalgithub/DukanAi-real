import { Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseLifecycleService } from './purchase-lifecycle.service';
import { Prisma } from '@prisma/client';

/**
 * Purchase-order approval (roadmap 4.2). Submission opens one PENDING
 * approval step; a manager other than the creator or submitter decides it,
 * and the decision moves the order SUBMITTED -> APPROVED / REJECTED in the
 * same transaction. Every lookup is scoped to the shop.
 */
@Injectable()
export class PurchaseApprovalService {
  private readonly logger = new Logger(PurchaseApprovalService.name);

  constructor(
    private readonly audit: PurchaseAuditService,
    private readonly lifecycle: PurchaseLifecycleService,
  ) {}

  async submitForApproval(tx: Prisma.TransactionClient, shopId: string, purchaseOrderId: string, actorId: string, comments?: string) {
    this.logger.debug(`Submitting PO ${purchaseOrderId} for approval`);

    const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shopId, isDeleted: false }, include: { items: true } });
    if (!po) throw new NotFoundException({ message: 'Purchase order not found', code: 'PURCHASE_ORDER_NOT_FOUND' });
    if (po.items.length === 0) throw new BadRequestException({ message: 'A purchase order needs at least one line before submission.', code: 'PURCHASE_ORDER_EMPTY' });

    await this.lifecycle.transitionStatus(tx, purchaseOrderId, shopId, po.status, 'SUBMITTED', actorId, 'Submitted for review');

    await tx.purchaseOrderApproval.create({
      data: {
        purchaseOrderId,
        shopId,
        approverId: 'MANAGER_ROLE', // any MANAGER+ other than the creator / submitter may decide
        status: 'PENDING',
        comments,
        step: 1,
      },
    });

    await this.audit.recordAudit(tx, purchaseOrderId, shopId, 'SUBMITTED', actorId, { status: po.status }, { status: 'SUBMITTED', comments: comments ?? null }, undefined);
    return tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shopId }, include: { items: true } });
  }

  async processApproval(
    tx: Prisma.TransactionClient,
    shopId: string,
    purchaseOrderId: string,
    actorId: string,
    action: 'APPROVE' | 'REJECT',
    comments?: string,
    signature?: string,
  ) {
    const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shopId, isDeleted: false } });
    if (!po) throw new NotFoundException({ message: 'Purchase order not found', code: 'PURCHASE_ORDER_NOT_FOUND' });

    if (action === 'APPROVE') {
      // Separation of duties: whoever created or submitted the order cannot approve it.
      const requested = await tx.purchaseOrderAudit.findFirst({
        where: { purchaseOrderId, shopId, actorId, action: { in: ['CREATED', 'SUBMITTED'] } },
        select: { id: true },
      });
      if (requested) throw new ForbiddenException({ message: 'The person who created or submitted a purchase order cannot approve it.', code: 'SEPARATION_OF_DUTIES' });
    }

    const pendingApproval = await tx.purchaseOrderApproval.findFirst({
      where: { purchaseOrderId, shopId, status: 'PENDING' },
      orderBy: { step: 'desc' },
    });
    if (!pendingApproval) {
      throw new BadRequestException({ message: 'No pending approvals for this purchase order', code: 'PURCHASE_ORDER_NOT_PENDING' });
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

    // The status transition is the concurrency guard; the approval row follows it.
    await this.lifecycle.transitionStatus(tx, purchaseOrderId, shopId, po.status, nextStatus, actorId, comments);
    await tx.purchaseOrderApproval.update({
      where: { id: pendingApproval.id },
      data: { status: nextStatus, approverId: actorId, comments, digitalSignature: signature, updatedAt: new Date() },
    });

    await this.audit.recordAudit(tx, purchaseOrderId, shopId, `APPROVAL_${action}`, actorId, { status: po.status }, { status: nextStatus, comments: comments ?? null }, undefined);

    return tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shopId }, include: { items: true } });
  }
}

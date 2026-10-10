import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Purchase-return approval (roadmap 4.2): submission opens one PENDING step
 * and moves the return to PENDING_APPROVAL; a manager other than the creator
 * decides it. Nothing used to create the step, so approval always failed.
 */
@Injectable()
export class PurchaseReturnApprovalService {
  async openApproval(tx: Prisma.TransactionClient, shopId: string, purchaseReturnId: string, comments?: string): Promise<void> {
    const open = await tx.purchaseReturnApproval.findFirst({ where: { purchaseReturnId, shopId, status: 'PENDING' }, select: { id: true } });
    if (open) return;
    await tx.purchaseReturnApproval.create({ data: { purchaseReturnId, shopId, approverId: 'MANAGER_ROLE', status: 'PENDING', step: 1, comments } });
  }

  async processApproval(
    tx: Prisma.TransactionClient,
    shopId: string,
    id: string,
    actorId: string,
    action: 'APPROVE' | 'REJECT',
    comments?: string,
    signature?: string,
  ): Promise<'APPROVED' | 'REJECTED'> {
    const pendingApproval = await tx.purchaseReturnApproval.findFirst({
      where: { purchaseReturnId: id, shopId, status: 'PENDING' },
      orderBy: { step: 'desc' },
    });
    if (!pendingApproval) throw new BadRequestException({ message: 'No pending approvals for this purchase return', code: 'PURCHASE_RETURN_NOT_PENDING' });

    if (action === 'APPROVE') {
      const pr = await tx.purchaseReturn.findFirst({ where: { id, shopId }, select: { createdBy: true } });
      const createdAudit = await tx.purchaseReturnAudit.findFirst({ where: { purchaseReturnId: id, shopId, actorId, action: { in: ['CREATED', 'SUBMITTED'] } }, select: { id: true } });
      if (pr?.createdBy === actorId || createdAudit) throw new ForbiddenException({ message: 'The person who created or submitted a purchase return cannot approve it.', code: 'SEPARATION_OF_DUTIES' });
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await tx.purchaseReturnApproval.update({
      where: { id: pendingApproval.id },
      data: { status: nextStatus, approverId: actorId, comments, digitalSignature: signature, updatedAt: new Date() },
    });
    return nextStatus;
  }
}

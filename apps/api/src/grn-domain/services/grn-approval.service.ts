import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Goods-receipt approval (roadmap 4.2). Accepting the goods opens one
 * PENDING approval step; a manager other than the receiver decides it, and
 * an approval completes the receipt (ACCEPTED -> COMPLETED). Nothing used to
 * create the step, so every approval failed with "No pending approvals".
 */
@Injectable()
export class GrnApprovalService {
  async openApproval(tx: Prisma.TransactionClient, shopId: string, goodsReceiptId: string): Promise<void> {
    const open = await tx.goodsReceiptApproval.findFirst({ where: { goodsReceiptId, shopId, status: 'PENDING' }, select: { id: true } });
    if (open) return;
    await tx.goodsReceiptApproval.create({ data: { goodsReceiptId, shopId, approverId: 'MANAGER_ROLE', status: 'PENDING', step: 1 } });
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
    const pendingApproval = await tx.goodsReceiptApproval.findFirst({
      where: { goodsReceiptId: id, shopId, status: 'PENDING' },
      orderBy: { step: 'desc' },
    });
    if (!pendingApproval) throw new BadRequestException({ message: 'No pending approvals for this goods receipt', code: 'GRN_NOT_PENDING' });

    if (action === 'APPROVE') {
      // Separation of duties: the receiver who created the GRN cannot approve it.
      const grn = await tx.goodsReceipt.findFirst({ where: { id, shopId }, select: { createdBy: true } });
      const createdAudit = await tx.goodsReceiptAudit.findFirst({ where: { goodsReceiptId: id, shopId, actorId, action: 'CREATED' }, select: { id: true } });
      if (grn?.createdBy === actorId || createdAudit) throw new ForbiddenException({ message: 'The person who created a goods receipt cannot approve it.', code: 'SEPARATION_OF_DUTIES' });
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await tx.goodsReceiptApproval.update({
      where: { id: pendingApproval.id },
      data: { status: nextStatus, approverId: actorId, comments, digitalSignature: signature, updatedAt: new Date() },
    });
    return nextStatus;
  }
}

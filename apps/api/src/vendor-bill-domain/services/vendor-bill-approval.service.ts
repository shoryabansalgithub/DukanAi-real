import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Vendor-bill approval (roadmap 4.2): submission opens one PENDING step and
 * moves the bill to PENDING_APPROVAL; a manager other than the creator or
 * submitter decides it. Nothing used to create the step, so approval always
 * failed and no bill could ever be posted or paid.
 */
@Injectable()
export class VendorBillApprovalService {
  async openApproval(tx: Prisma.TransactionClient, shopId: string, vendorBillId: string, comments?: string): Promise<void> {
    const open = await tx.vendorBillApproval.findFirst({ where: { vendorBillId, shopId, status: 'PENDING' }, select: { id: true } });
    if (open) return;
    await tx.vendorBillApproval.create({ data: { vendorBillId, shopId, approverId: 'MANAGER_ROLE', status: 'PENDING', step: 1, comments } });
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
    const pendingApproval = await tx.vendorBillApproval.findFirst({
      where: { vendorBillId: id, shopId, status: 'PENDING' },
      orderBy: { step: 'desc' },
    });
    if (!pendingApproval) throw new BadRequestException({ message: 'No pending approvals for this vendor bill', code: 'VENDOR_BILL_NOT_PENDING' });

    if (action === 'APPROVE') {
      const bill = await tx.vendorBill.findFirst({ where: { id, shopId }, select: { createdBy: true } });
      const createdAudit = await tx.vendorBillAudit.findFirst({ where: { vendorBillId: id, shopId, actorId, action: { in: ['CREATED', 'SUBMITTED'] } }, select: { id: true } });
      if (bill?.createdBy === actorId || createdAudit) throw new ForbiddenException({ message: 'The person who created or submitted a vendor bill cannot approve it.', code: 'SEPARATION_OF_DUTIES' });
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await tx.vendorBillApproval.update({
      where: { id: pendingApproval.id },
      data: { status: nextStatus, approverId: actorId, comments, digitalSignature: signature, updatedAt: new Date() },
    });
    return nextStatus;
  }
}

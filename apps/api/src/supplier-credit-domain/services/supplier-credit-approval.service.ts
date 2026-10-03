import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Supplier credit-note approval (roadmap 4.2): submission opens one PENDING
 * step and moves the note to PENDING_APPROVAL; a manager other than the
 * creator or submitter decides it, and an approval issues the note.
 */
@Injectable()
export class SupplierCreditApprovalService {
  async openApproval(tx: Prisma.TransactionClient, shopId: string, supplierCreditId: string, comments?: string): Promise<void> {
    const open = await tx.supplierCreditApproval.findFirst({ where: { supplierCreditId, shopId, status: 'PENDING' }, select: { id: true } });
    if (open) return;
    await tx.supplierCreditApproval.create({ data: { supplierCreditId, shopId, approverId: 'MANAGER_ROLE', status: 'PENDING', step: 1, comments } });
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
    const pendingApproval = await tx.supplierCreditApproval.findFirst({
      where: { supplierCreditId: id, shopId, status: 'PENDING' },
      orderBy: { step: 'desc' },
    });
    if (!pendingApproval) throw new BadRequestException({ message: 'No pending approvals for this credit note', code: 'SUPPLIER_CREDIT_NOT_PENDING' });

    if (action === 'APPROVE') {
      const note = await tx.supplierCreditNote.findFirst({ where: { id, shopId }, select: { createdBy: true } });
      const createdAudit = await tx.supplierCreditAudit.findFirst({ where: { supplierCreditId: id, shopId, actorId, action: { in: ['CREATED', 'SUBMITTED'] } }, select: { id: true } });
      if (note?.createdBy === actorId || createdAudit) throw new ForbiddenException({ message: 'The person who created or submitted a credit note cannot approve it.', code: 'SEPARATION_OF_DUTIES' });
    }

    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await tx.supplierCreditApproval.update({
      where: { id: pendingApproval.id },
      data: { status: nextStatus, approverId: actorId, comments, digitalSignature: signature, updatedAt: new Date() },
    });
    return nextStatus;
  }
}

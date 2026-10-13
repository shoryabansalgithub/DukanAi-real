import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { SupplierCreditStatus, Prisma } from '@prisma/client';

@Injectable()
export class SupplierCreditLifecycleService {
  static readonly TRANSITIONS: Record<SupplierCreditStatus, SupplierCreditStatus[]> = {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['PENDING_APPROVAL', 'CANCELLED'],
    // A note waiting for its approver may still be withdrawn (release audit S24).
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['ISSUED'],
    ISSUED: ['ALLOCATED', 'CLOSED'],
    ALLOCATED: ['CLOSED'],
    CLOSED: ['ARCHIVED'],
    REJECTED: ['ARCHIVED', 'DRAFT'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED: []
  };

  validateTransition(current: SupplierCreditStatus, target: SupplierCreditStatus) {
    if (!SupplierCreditLifecycleService.TRANSITIONS[current]?.includes(target)) {
      throw new BadRequestException({ message: `Invalid Supplier Credit Note transition from ${current} to ${target}`, code: 'SUPPLIER_CREDIT_TRANSITION_INVALID', details: { from: current, to: target } });
    }
  }

  /** Compare-and-set (release audit S14): of two concurrent transitions one wins, the other is 409 SUPPLIER_CREDIT_STATE_CONFLICT. */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    id: string,
    shopId: string,
    currentStatus: SupplierCreditStatus,
    targetStatus: SupplierCreditStatus,
    actorId: string,
    notes?: string
  ) {
    this.validateTransition(currentStatus, targetStatus);

    const moved = await tx.supplierCreditNote.updateMany({ where: { id, shopId, status: currentStatus }, data: { status: targetStatus } });
    if (moved.count === 0) {
      throw new ConflictException({ message: 'The credit note changed state concurrently; reload and retry.', code: 'SUPPLIER_CREDIT_STATE_CONFLICT', details: { expected: currentStatus, target: targetStatus } });
    }

    await tx.supplierCreditStatusHistory.create({
      data: {
        supplierCreditId: id,
        shopId,
        status: targetStatus,
        actorId,
        notes
      }
    });
  }
}

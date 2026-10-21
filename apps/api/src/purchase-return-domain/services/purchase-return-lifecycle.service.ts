import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PurchaseReturnStatus, Prisma } from '@prisma/client';

@Injectable()
export class PurchaseReturnLifecycleService {
  static readonly TRANSITIONS: Record<PurchaseReturnStatus, PurchaseReturnStatus[]> = {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['PENDING_APPROVAL', 'CANCELLED'],
    // A return waiting for its approver may still be withdrawn (release audit S24).
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['SHIPPED', 'COMPLETED'], // Sometimes physical shipment isn't needed if it's virtual return
    SHIPPED: ['COMPLETED'],
    COMPLETED: [],
    REJECTED: ['ARCHIVED', 'DRAFT'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED: []
  };

  validateTransition(current: PurchaseReturnStatus, target: PurchaseReturnStatus) {
    if (!PurchaseReturnLifecycleService.TRANSITIONS[current]?.includes(target)) {
      throw new BadRequestException({ message: `Invalid Purchase Return transition from ${current} to ${target}`, code: 'PURCHASE_RETURN_TRANSITION_INVALID', details: { from: current, to: target } });
    }
  }

  /** Compare-and-set (release audit S14): of two concurrent transitions one wins, the other is 409 PURCHASE_RETURN_STATE_CONFLICT. */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    id: string,
    shopId: string,
    currentStatus: PurchaseReturnStatus,
    targetStatus: PurchaseReturnStatus,
    actorId: string,
    notes?: string
  ) {
    this.validateTransition(currentStatus, targetStatus);

    const moved = await tx.purchaseReturn.updateMany({ where: { id, shopId, status: currentStatus }, data: { status: targetStatus } });
    if (moved.count === 0) {
      throw new ConflictException({ message: 'The purchase return changed state concurrently; reload and retry.', code: 'PURCHASE_RETURN_STATE_CONFLICT', details: { expected: currentStatus, target: targetStatus } });
    }

    await tx.purchaseReturnStatusHistory.create({
      data: {
        purchaseReturnId: id,
        shopId,
        status: targetStatus,
        actorId,
        notes
      }
    });
  }
}

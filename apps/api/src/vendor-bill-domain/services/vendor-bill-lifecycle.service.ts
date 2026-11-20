import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { VendorBillStatus, Prisma } from '@prisma/client';

@Injectable()
export class VendorBillLifecycleService {
  static readonly TRANSITIONS: Record<VendorBillStatus, VendorBillStatus[]> = {
    DRAFT: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['PENDING_APPROVAL', 'CANCELLED'],
    // A bill waiting for its approver may still be withdrawn (release audit S24).
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['POSTED'],
    POSTED: ['PARTIALLY_PAID', 'PAID'],
    // A bill may be paid in several instalments (roadmap 4.2): PARTIALLY_PAID stays PARTIALLY_PAID until the last one.
    PARTIALLY_PAID: ['PARTIALLY_PAID', 'PAID'],
    PAID: ['CLOSED'],
    CLOSED: ['ARCHIVED'],
    REJECTED: ['ARCHIVED'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED: []
  };

  validateTransition(current: VendorBillStatus, target: VendorBillStatus) {
    if (!VendorBillLifecycleService.TRANSITIONS[current]?.includes(target)) {
      throw new BadRequestException({ message: `Invalid Vendor Bill transition from ${current} to ${target}`, code: 'VENDOR_BILL_TRANSITION_INVALID', details: { from: current, to: target } });
    }
  }

  /** Compare-and-set (release audit S5/S14): of two concurrent transitions one wins, the other is 409 VENDOR_BILL_STATE_CONFLICT. */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    id: string,
    shopId: string,
    currentStatus: VendorBillStatus,
    targetStatus: VendorBillStatus,
    actorId: string | null,
    notes?: string
  ) {
    this.validateTransition(currentStatus, targetStatus);

    const moved = await tx.vendorBill.updateMany({ where: { id, shopId, status: currentStatus }, data: { status: targetStatus } });
    if (moved.count === 0) {
      throw new ConflictException({ message: 'The vendor bill changed state concurrently; reload and retry.', code: 'VENDOR_BILL_STATE_CONFLICT', details: { expected: currentStatus, target: targetStatus } });
    }

    await tx.vendorBillStatusHistory.create({
      data: {
        vendorBillId: id,
        shopId,
        status: targetStatus,
        actorId,
        notes
      }
    });
  }
}

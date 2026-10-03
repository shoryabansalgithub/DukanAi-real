import { Injectable, BadRequestException } from '@nestjs/common';
import { VendorBillStatus, Prisma } from '@prisma/client';

@Injectable()
export class VendorBillLifecycleService {
  validateTransition(current: VendorBillStatus, target: VendorBillStatus) {
    const allowed: Record<VendorBillStatus, VendorBillStatus[]> = {
      DRAFT: ['SUBMITTED', 'CANCELLED'],
      SUBMITTED: ['PENDING_APPROVAL', 'CANCELLED'],
      PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
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

    if (!allowed[current]?.includes(target)) {
      throw new BadRequestException(`Invalid Vendor Bill transition from ${current} to ${target}`);
    }
  }

  async transitionStatus(
    tx: Prisma.TransactionClient, 
    id: string, 
    shopId: string, 
    currentStatus: VendorBillStatus, 
    targetStatus: VendorBillStatus, 
    actorId: string, 
    notes?: string
  ) {
    this.validateTransition(currentStatus, targetStatus);
    
    await tx.vendorBill.update({
      where: { id },
      data: { status: targetStatus }
    });

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

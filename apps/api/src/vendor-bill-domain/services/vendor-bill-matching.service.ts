import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class VendorBillMatchingService {
  /**
   * Enterprise Three-Way Matching Engine
   * Validates: PO Quantity >= GRN Quantity >= Billed Quantity
   */
  async enforceThreeWayMatch(
    tx: Prisma.TransactionClient,
    shopId: string,
    vendorBillLines: any[],
    tolerancePercentage: number = 0,
    excludeBillId?: string,
  ) {
    for (const billLine of vendorBillLines) {
      if (!billLine.purchaseOrderLineId || !billLine.grnLineId) continue;

      const poLine = await tx.purchaseOrderItem.findFirst({
        where: { id: billLine.purchaseOrderLineId, shopId }
      });

      const grnLine = await tx.goodsReceiptLine.findFirst({
        where: { id: billLine.grnLineId, shopId }
      });

      if (!poLine || !grnLine) {
        throw new BadRequestException('Matching documents not found for Three-Way match');
      }
      if (grnLine.productId !== billLine.productId || poLine.productId !== billLine.productId) {
        throw new BadRequestException('Three-Way Match Failed: the bill line names a different product than the matched order and receipt lines');
      }

      // Billed quantity is cumulative over the other live bills of the same receipt line (roadmap 4.2).
      const priorBilled = await tx.vendorBillLine.aggregate({
        where: { grnLineId: billLine.grnLineId, shopId, isDeleted: false, vendorBill: { isDeleted: false, status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] }, ...(excludeBillId ? { id: { not: excludeBillId } } : {}) } },
        _sum: { billedQuantity: true },
      });
      const ordered = new Decimal(poLine.quantity as any || 0);
      const received = new Decimal(grnLine.acceptedQuantity as any || 0);
      const billed = new Decimal(billLine.billedQuantity || 0).plus(new Decimal(priorBilled._sum.billedQuantity?.toString() ?? 0));

      // Rule 1: Cannot bill more than what was accepted in GRN (plus tolerance)
      const maxAllowedBill = received.mul(new Decimal(1).plus(new Decimal(tolerancePercentage).div(100)));
      
      if (billed.greaterThan(maxAllowedBill)) {
        throw new BadRequestException(
          `Three-Way Match Failed: Billed quantity (${billed.toNumber()}) exceeds Received quantity (${received.toNumber()})`
        );
      }

      // Rule 2: GRN quantity should ideally match PO quantity, but that's GRN's job. 
      // Vendor Bill just checks it against PO for audit safety.
      const maxAllowedOrdered = ordered.mul(new Decimal(1).plus(new Decimal(tolerancePercentage).div(100)));
      if (billed.greaterThan(maxAllowedOrdered)) {
         throw new BadRequestException(
          `Three-Way Match Failed: Billed quantity (${billed.toNumber()}) exceeds Ordered quantity (${ordered.toNumber()})`
        );
      }
    }
  }
}

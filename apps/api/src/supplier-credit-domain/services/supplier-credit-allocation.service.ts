import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class SupplierCreditAllocationService {
  /**
   * Enterprise Allocation Engine
   * Allocates a portion of a Supplier Credit Note to a specific Vendor Bill.
   * Decrements outstandingAmount on Vendor Bill.
   */
  async processAllocation(tx: Prisma.TransactionClient, shopId: string, creditNote: any, vendorBillId: string, allocationAmount: number, actorId?: string) {
    const vendorBill = await tx.vendorBill.findUnique({
      where: { id: vendorBillId, shopId }
    });

    if (!vendorBill) throw new BadRequestException(`Vendor Bill ${vendorBillId} not found for allocation`);

    const remainingCredit = new Decimal(creditNote.remainingBalance as any || 0);
    const outstandingBill = new Decimal(vendorBill.outstandingAmount as any || 0);
    const allocation = new Decimal(allocationAmount);

    if (allocation.greaterThan(remainingCredit)) {
      throw new BadRequestException(`Allocation amount (${allocation.toNumber()}) exceeds remaining credit balance (${remainingCredit.toNumber()})`);
    }

    if (allocation.greaterThan(outstandingBill)) {
      throw new BadRequestException(`Allocation amount (${allocation.toNumber()}) exceeds Vendor Bill outstanding balance (${outstandingBill.toNumber()})`);
    }

    // 1. Create Allocation Mapping Record
    await tx.supplierCreditAllocation.create({
      data: {
        shopId,
        supplierCreditId: creditNote.id,
        vendorBillId: vendorBill.id,
        allocatedAmount: allocationAmount,
        notes: `Automated Allocation of ${allocationAmount}`
      }
    });

    // 2. Reduce Vendor Bill Outstanding and settle its status (roadmap 4.2):
    //    a bill whose balance the credit clears is PAID, otherwise it is
    //    PARTIALLY_PAID, exactly as a cash instalment would leave it.
    const outstandingAfter = outstandingBill.minus(allocation);
    const billStatus = outstandingAfter.lte(0) ? 'PAID' : 'PARTIALLY_PAID';
    await tx.vendorBill.update({
      where: { id: vendorBillId },
      data: {
        outstandingAmount: { decrement: allocationAmount },
        status: billStatus,
      }
    });
    if (billStatus !== vendorBill.status) {
      await tx.vendorBillStatusHistory.create({
        data: { vendorBillId, shopId, status: billStatus, actorId: actorId ?? null, notes: `Credit note ${creditNote.creditNumber} applied: ${allocation.toFixed(2)}` }
      });
    }

    // 3. Reduce Credit Note Remaining Balance
    await tx.supplierCreditNote.update({
      where: { id: creditNote.id },
      data: {
        allocatedAmount: { increment: allocationAmount },
        remainingBalance: { decrement: allocationAmount }
      }
    });

    return true;
  }
}

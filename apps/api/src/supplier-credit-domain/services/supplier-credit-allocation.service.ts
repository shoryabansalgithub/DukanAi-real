import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class SupplierCreditAllocationService {
  /**
   * Applies part of an issued credit note to a vendor bill of the same
   * supplier (release audit S5/L4). Lock order: the bill, then the note
   * (`FOR UPDATE` both), so two allocations against one bill or one note
   * are decided one after the other; both balances then move by guarded
   * decrements (`remainingBalance >= amount`, `outstandingAmount >= amount`)
   * and the bill's status by compare-and-set, so a concurrent payment or
   * allocation that got there first makes this one fail instead of
   * over-settling. The payable itself already moved when the note was
   * issued (or its return completed): an allocation posts nothing.
   */
  async processAllocation(tx: Prisma.TransactionClient, shopId: string, creditNoteId: string, vendorBillId: string, amount: Prisma.Decimal, actorId?: string) {
    const bills = await tx.$queryRaw<Array<{ id: string; supplierId: string; status: string; outstandingAmount: unknown }>>`
      SELECT id, supplierId, status, outstandingAmount FROM VendorBill WHERE id = ${vendorBillId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    const bill = bills[0];
    if (!bill) throw new NotFoundException({ message: `Vendor Bill ${vendorBillId} not found.`, code: 'VENDOR_BILL_NOT_FOUND' });
    const notes = await tx.$queryRaw<Array<{ id: string; supplierId: string; status: string; creditNumber: string; remainingBalance: unknown }>>`
      SELECT id, supplierId, status, creditNumber, remainingBalance FROM SupplierCreditNote WHERE id = ${creditNoteId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    const note = notes[0];
    if (!note) throw new NotFoundException({ message: `Supplier Credit Note ${creditNoteId} not found.`, code: 'SUPPLIER_CREDIT_NOT_FOUND' });

    // Only an issued note carries a balance that can be applied.
    if (note.status !== 'ISSUED' && note.status !== 'ALLOCATED') {
      throw new BadRequestException({ message: `Credit note ${note.creditNumber} is ${note.status}; only an issued note can be allocated.`, code: 'SUPPLIER_CREDIT_NOT_ALLOCATABLE' });
    }
    if (bill.supplierId !== note.supplierId) throw new BadRequestException({ message: 'A credit note can only be applied to a bill of the same supplier.', code: 'SUPPLIER_CREDIT_SUPPLIER_MISMATCH' });
    if (bill.status !== 'POSTED' && bill.status !== 'PARTIALLY_PAID') {
      throw new BadRequestException({ message: `Vendor bill is ${bill.status}; only a posted bill carries an outstanding balance.`, code: 'VENDOR_BILL_NOT_PAYABLE' });
    }

    const allocation = amount.toDecimalPlaces(2);
    const remainingCredit = new Prisma.Decimal(String(note.remainingBalance));
    const outstandingBill = new Prisma.Decimal(String(bill.outstandingAmount));
    if (allocation.greaterThan(remainingCredit)) {
      throw new BadRequestException({ message: `Allocation amount (${allocation.toFixed(2)}) exceeds remaining credit balance (${remainingCredit.toFixed(2)})`, code: 'SUPPLIER_CREDIT_INSUFFICIENT' });
    }
    if (allocation.greaterThan(outstandingBill)) {
      throw new BadRequestException({ message: `Allocation amount (${allocation.toFixed(2)}) exceeds Vendor Bill outstanding balance (${outstandingBill.toFixed(2)})`, code: 'VENDOR_BILL_OVERPAYMENT' });
    }

    // 1. The note's balance, guarded.
    const noteMoved = await tx.supplierCreditNote.updateMany({
      where: { id: creditNoteId, shopId, remainingBalance: { gte: allocation } },
      data: { allocatedAmount: { increment: allocation }, remainingBalance: { decrement: allocation } },
    });
    if (noteMoved.count === 0) throw new ConflictException({ message: 'The credit note balance changed concurrently; reload and retry.', code: 'SUPPLIER_CREDIT_STATE_CONFLICT' });

    // 2. The bill's outstanding and status (a bill whose balance the credit clears is PAID), guarded on both.
    const outstandingAfter = outstandingBill.minus(allocation);
    const billStatus = outstandingAfter.lte(0) ? 'PAID' : 'PARTIALLY_PAID';
    const billMoved = await tx.vendorBill.updateMany({
      where: { id: vendorBillId, shopId, status: bill.status as 'POSTED' | 'PARTIALLY_PAID', outstandingAmount: { gte: allocation } },
      data: { outstandingAmount: { decrement: allocation }, status: billStatus },
    });
    if (billMoved.count === 0) throw new ConflictException({ message: 'The vendor bill changed concurrently; reload and retry.', code: 'VENDOR_BILL_STATE_CONFLICT' });
    if (billStatus !== bill.status) {
      await tx.vendorBillStatusHistory.create({
        data: { vendorBillId, shopId, status: billStatus, actorId: actorId ?? null, notes: `Credit note ${note.creditNumber} applied: ${allocation.toFixed(2)}` }
      });
    }

    // 3. The mapping row.
    await tx.supplierCreditAllocation.create({
      data: {
        shopId,
        supplierCreditId: creditNoteId,
        vendorBillId,
        allocatedAmount: allocation,
        notes: `Credit note ${note.creditNumber} applied: ${allocation.toFixed(2)}`
      }
    });

    return { noteStatus: note.status };
  }
}

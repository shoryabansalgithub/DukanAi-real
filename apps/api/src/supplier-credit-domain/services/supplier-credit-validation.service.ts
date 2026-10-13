import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Credit notes that count against their purchase return's value (every note that is not withdrawn or refused). */
export const LIVE_CREDIT_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'ALLOCATED', 'CLOSED'] as const;

export interface CreditReferences {
  supplierId: string;
  purchaseReturnId?: string | null;
  vendorBillId?: string | null;
}

@Injectable()
export class SupplierCreditValidationService {
  /**
   * The references of a credit note must be authentic (release audit S10):
   * a bill or a return of the note's own supplier; a note backed by a
   * purchase return needs that return COMPLETED (the goods are back with
   * the supplier and the payable already went down) and all the live notes
   * of one return together never exceed the return's value. The return row
   * is locked (`FOR UPDATE`) so two notes for one return are decided one
   * after the other.
   */
  async validateReferences(tx: Prisma.TransactionClient, shopId: string, refs: CreditReferences, total: Prisma.Decimal, excludeNoteId?: string) {
    if (refs.vendorBillId) {
      const bill = await tx.vendorBill.findFirst({ where: { id: refs.vendorBillId, shopId, isDeleted: false }, select: { supplierId: true } });
      if (!bill) throw new NotFoundException({ message: 'Referenced vendor bill does not exist.', code: 'VENDOR_BILL_NOT_FOUND' });
      if (bill.supplierId !== refs.supplierId) throw new BadRequestException({ message: 'The vendor bill does not belong to the note\'s supplier.', code: 'SUPPLIER_CREDIT_SUPPLIER_MISMATCH' });
    }

    if (refs.purchaseReturnId) {
      const rows = await tx.$queryRaw<Array<{ id: string; supplierId: string; status: string; totalAmount: unknown }>>`
        SELECT id, supplierId, status, totalAmount FROM PurchaseReturn WHERE id = ${refs.purchaseReturnId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
      `;
      const pr = rows[0];
      if (!pr) throw new NotFoundException({ message: 'Referenced purchase return does not exist.', code: 'PURCHASE_RETURN_NOT_FOUND' });
      if (pr.supplierId !== refs.supplierId) throw new BadRequestException({ message: 'The purchase return does not belong to the note\'s supplier.', code: 'SUPPLIER_CREDIT_SUPPLIER_MISMATCH' });
      if (pr.status !== 'COMPLETED') {
        throw new ConflictException({ message: `A credit note for a purchase return needs the return COMPLETED; it is ${pr.status}.`, code: 'SUPPLIER_CREDIT_RETURN_NOT_COMPLETED', details: { status: pr.status } });
      }
      const others = await tx.supplierCreditNote.aggregate({
        where: { shopId, purchaseReturnId: pr.id, isDeleted: false, status: { in: [...LIVE_CREDIT_STATUSES] }, ...(excludeNoteId ? { id: { not: excludeNoteId } } : {}) },
        _sum: { totalAmount: true },
      });
      const returnValue = new Prisma.Decimal(String(pr.totalAmount));
      const credited = (others._sum.totalAmount ?? new Prisma.Decimal(0)).plus(total);
      if (credited.greaterThan(returnValue)) {
        throw new BadRequestException({
          message: `Credit notes for this return would total ${credited.toFixed(2)}, more than the return's value ${returnValue.toFixed(2)}.`,
          code: 'SUPPLIER_CREDIT_EXCEEDS_RETURN',
          details: { returnValue: returnValue.toFixed(2), credited: credited.toFixed(2) },
        });
      }
    }
  }
}

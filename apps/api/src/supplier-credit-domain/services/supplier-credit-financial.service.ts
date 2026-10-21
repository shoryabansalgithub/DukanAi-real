import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { SupplierPayablesService } from '../../ledger/supplier-payables.service';
import { LedgerEntryInput } from '../../ledger/ledger-posting.service';

export interface IssuedCreditNote {
  id: string;
  creditNumber: string;
  supplierId: string;
  purchaseReturnId: string | null;
  totalAmount: Prisma.Decimal;
  /** GST inside the note (Σ of its lines' tax). */
  taxAmount: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

/**
 * What issuing a supplier credit note does to the books (release audit S10).
 *
 * A note that is not backed by a purchase return (a price difference, a
 * rate or volume discount, a short-supply claim) lowers what the shop owes
 * at once: DR ACCOUNTS_PAYABLE for the note, CR INPUT_GST for the GST inside
 * it (the input tax credit shrinks with the supplier's credit) and CR
 * INVENTORY for the rest. INVENTORY, not a separate price-difference
 * account: the credit lowers what the goods cost, and the receipt debited
 * that cost to INVENTORY; a separate account would leave INVENTORY above the
 * receipts' real cost for good (there is no purchase-price-variance account
 * in this chart, and COST_OF_GOODS would claim the goods were sold).
 * `pendingPayables` goes down by the note.
 *
 * A note backed by a COMPLETED purchase return: the return already posted
 * DR AP / CR INVENTORY for the goods' value, so the note only adds what the
 * return could not know, the GST on the returned goods: the part of the
 * notes for that return above the return's posted value is DR AP / CR
 * INPUT_GST. Several notes for one return are capped together at the
 * return's value by the validation, so the books never credit twice.
 * Allocating a note to a bill posts nothing (the payable already moved).
 */
@Injectable()
export class SupplierCreditFinancialService {
  private readonly logger = new Logger(SupplierCreditFinancialService.name);

  constructor(private readonly payables: SupplierPayablesService) {}

  async postIssuedNote(tx: Prisma.TransactionClient, shopId: string, note: IssuedCreditNote): Promise<Prisma.Decimal> {
    const entries: LedgerEntryInput[] = [];
    let payableDebit = ZERO;

    if (!note.purchaseReturnId) {
      const tax = Prisma.Decimal.min(note.taxAmount, note.totalAmount);
      const goods = note.totalAmount.minus(tax);
      payableDebit = note.totalAmount;
      entries.push({ account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount: payableDebit });
      if (tax.greaterThan(0)) entries.push({ account: LedgerAccount.INPUT_GST, type: LedgerEntryType.CREDIT, amount: tax });
      if (goods.greaterThan(0)) entries.push({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: goods });
    } else {
      const returnPosted = await this.returnPostedValue(tx, shopId, note.purchaseReturnId);
      const earlier = await tx.supplierCreditNote.aggregate({
        where: { shopId, purchaseReturnId: note.purchaseReturnId, isDeleted: false, status: { in: ['ISSUED', 'ALLOCATED', 'CLOSED'] }, id: { not: note.id } },
        _sum: { totalAmount: true },
      });
      const before = earlier._sum.totalAmount ?? ZERO;
      const above = (credited: Prisma.Decimal) => Prisma.Decimal.max(credited.minus(returnPosted), 0);
      payableDebit = above(before.plus(note.totalAmount)).minus(above(before)).toDecimalPlaces(2);
      if (payableDebit.greaterThan(0)) {
        entries.push({ account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount: payableDebit });
        entries.push({ account: LedgerAccount.INPUT_GST, type: LedgerEntryType.CREDIT, amount: payableDebit });
      }
    }

    if (entries.length === 0) return ZERO;
    await this.payables.postWithPayable(
      tx,
      note.supplierId,
      { shopId, source: { type: 'SUPPLIER_CREDIT_NOTE', id: note.id }, invoiceId: null, description: `Supplier credit note ${note.creditNumber}`, entries },
      payableDebit.negated(),
    );
    this.logger.log(`Credit note ${note.creditNumber} issued: payable reduced by ${payableDebit.toFixed(2)}`);
    return payableDebit;
  }

  /** The value the purchase return's posting took off ACCOUNTS_PAYABLE (0 when it posted nothing). */
  private async returnPostedValue(tx: Prisma.TransactionClient, shopId: string, purchaseReturnId: string): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: unknown }>>`
      SELECT COALESCE(SUM(t.amount), 0) AS total FROM LedgerTransaction t
      JOIN LedgerPosting p ON p.id = t.postingId
      WHERE p.shopId = ${shopId} AND p.sourceType = 'PURCHASE_RETURN' AND p.sourceId = ${purchaseReturnId}
        AND t.account = 'ACCOUNTS_PAYABLE' AND t.type = 'DEBIT'
    `;
    return new Prisma.Decimal(String(rows[0]?.total ?? 0));
  }
}

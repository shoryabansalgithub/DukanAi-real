import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma, TenderType } from '@prisma/client';
import { LedgerPostingService } from './ledger-posting.service';

export interface SupplierPaymentInput {
  shopId: string;
  supplierId: string;
  amount: Prisma.Decimal | number | string;
  tender?: TenderType;
  reference?: string | null;
  idempotencyKey?: string | null;
  notes?: string | null;
  vendorBillId?: string | null;
  recordedById?: string | null;
}

export interface SupplierPaymentOutcome {
  payment: { id: string; amount: Prisma.Decimal; tender: TenderType; supplierId: string; vendorBillId: string | null; createdAt: Date };
  pendingPayables: Prisma.Decimal;
  replayed: boolean;
}

/**
 * Accounts payable per supplier (roadmap 3.11, audit P2-24). The ledger's
 * ACCOUNTS_PAYABLE account is the authority; `Supplier.pendingPayables` is
 * the per-supplier running balance maintained in the same transaction as
 * every posting that moves it:
 *   goods receipt      CR ACCOUNTS_PAYABLE   pendingPayables += value
 *   purchase return    DR ACCOUNTS_PAYABLE   pendingPayables -= value (floored at 0)
 *   supplier payment   DR ACCOUNTS_PAYABLE / CR CASH|BANK   pendingPayables -= amount (guarded)
 * A payment is a `SupplierPayment` row (the ledger source, idempotent per
 * (shopId, idempotencyKey)); the guarded decrement rejects paying more than
 * is owed instead of clamping it away silently. `payablesFromLedger` rebuilds
 * the balance from the postings so the denormalised column can be verified.
 */
@Injectable()
export class SupplierPayablesService {
  constructor(private readonly ledger: LedgerPostingService) {}

  /** Goods received on credit: the supplier is owed `value` more. */
  async addPayable(tx: Prisma.TransactionClient, shopId: string, supplierId: string | null | undefined, value: Prisma.Decimal): Promise<void> {
    if (!supplierId || value.lessThanOrEqualTo(0)) return;
    await tx.supplier.updateMany({ where: { id: supplierId, shopId }, data: { pendingPayables: { increment: value } } });
  }

  /** Goods sent back: the supplier is owed `value` less, never below zero. */
  async reducePayable(tx: Prisma.TransactionClient, shopId: string, supplierId: string | null | undefined, value: Prisma.Decimal): Promise<void> {
    if (!supplierId || value.lessThanOrEqualTo(0)) return;
    await tx.$executeRaw`
      UPDATE Supplier SET pendingPayables = GREATEST(pendingPayables - ${value.toFixed(2)}, 0), updatedAt = NOW(3)
      WHERE id = ${supplierId} AND shopId = ${shopId}
    `;
  }

  /** Records a payment, settles it against the payable and posts it, all inside `tx`. */
  async pay(tx: Prisma.TransactionClient, input: SupplierPaymentInput): Promise<SupplierPaymentOutcome> {
    const amount = new Prisma.Decimal(input.amount.toString()).toDecimalPlaces(2);
    if (amount.lessThanOrEqualTo(0)) throw new ConflictException({ message: 'A payment must be greater than zero.', code: 'PAYMENT_INVALID' });
    const tender = input.tender ?? TenderType.CASH;

    if (input.idempotencyKey) {
      const existing = await tx.supplierPayment.findFirst({ where: { shopId: input.shopId, idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const supplier = await tx.supplier.findFirstOrThrow({ where: { id: input.supplierId, shopId: input.shopId }, select: { pendingPayables: true } });
        return { payment: existing, pendingPayables: supplier.pendingPayables, replayed: true };
      }
    }

    // Guarded decrement: the row is locked and the balance must cover the payment.
    const rows = await tx.$queryRaw<Array<{ id: string; pendingPayables: unknown; isDeleted: number | boolean }>>`
      SELECT id, pendingPayables, isDeleted FROM Supplier WHERE id = ${input.supplierId} AND shopId = ${input.shopId} FOR UPDATE
    `;
    if (rows.length === 0 || Boolean(rows[0].isDeleted)) throw new NotFoundException({ message: 'Supplier not found.', code: 'SUPPLIER_NOT_FOUND' });
    const settled = await tx.$executeRaw`
      UPDATE Supplier SET pendingPayables = pendingPayables - ${amount.toFixed(2)}, updatedAt = NOW(3)
      WHERE id = ${input.supplierId} AND shopId = ${input.shopId} AND pendingPayables >= ${amount.toFixed(2)}
    `;
    if (settled === 0) {
      throw new ConflictException({
        message: 'The payment exceeds what is owed to this supplier.',
        code: 'PAYABLES_INSUFFICIENT',
        details: { pendingPayables: Number(String(rows[0].pendingPayables)), requested: amount.toNumber() },
      });
    }

    const payment = await tx.supplierPayment.create({
      data: {
        shopId: input.shopId,
        supplierId: input.supplierId,
        vendorBillId: input.vendorBillId ?? null,
        amount,
        tender,
        reference: input.reference ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        notes: input.notes ?? null,
        recordedById: input.recordedById ?? null,
      },
    });
    await this.ledger.post(tx, {
      shopId: input.shopId,
      source: { type: 'SUPPLIER_PAYMENT', id: payment.id },
      invoiceId: null,
      description: input.vendorBillId ? `Vendor bill payment ${input.vendorBillId}` : `Supplier payment ${payment.id}`,
      entries: [
        { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.DEBIT, amount },
        { account: tender === TenderType.CASH ? LedgerAccount.CASH : LedgerAccount.BANK, type: LedgerEntryType.CREDIT, amount },
      ],
    });
    const supplier = await tx.supplier.findFirstOrThrow({ where: { id: input.supplierId }, select: { pendingPayables: true } });
    return { payment, pendingPayables: supplier.pendingPayables, replayed: false };
  }

  /**
   * The balance the ledger implies for one supplier: opening balance, plus
   * every posted goods receipt, minus every posted purchase return and every
   * posted payment. Equals `Supplier.pendingPayables` when the books are
   * consistent; a mismatch points at a write that bypassed this service.
   */
  async payablesFromLedger(db: Prisma.TransactionClient, shopId: string, supplierId: string): Promise<Prisma.Decimal> {
    const supplier = await db.supplier.findFirstOrThrow({ where: { id: supplierId, shopId }, select: { openingPayables: true } });
    const [receipts, returns, payments] = await Promise.all([
      db.$queryRaw<Array<{ total: unknown }>>`
        SELECT COALESCE(SUM(t.amount), 0) AS total FROM LedgerTransaction t
        JOIN LedgerPosting p ON p.id = t.postingId AND p.sourceType = 'GRN'
        JOIN GoodsReceipt g ON g.id = p.sourceId AND g.supplierId = ${supplierId}
        WHERE t.shopId = ${shopId} AND t.account = 'ACCOUNTS_PAYABLE' AND t.type = 'CREDIT'
      `,
      db.$queryRaw<Array<{ total: unknown }>>`
        SELECT COALESCE(SUM(t.amount), 0) AS total FROM LedgerTransaction t
        JOIN LedgerPosting p ON p.id = t.postingId AND p.sourceType = 'PURCHASE_RETURN'
        JOIN PurchaseReturn r ON r.id = p.sourceId AND r.supplierId = ${supplierId}
        WHERE t.shopId = ${shopId} AND t.account = 'ACCOUNTS_PAYABLE' AND t.type = 'DEBIT'
      `,
      db.$queryRaw<Array<{ total: unknown }>>`
        SELECT COALESCE(SUM(t.amount), 0) AS total FROM LedgerTransaction t
        JOIN LedgerPosting p ON p.id = t.postingId AND p.sourceType = 'SUPPLIER_PAYMENT'
        JOIN SupplierPayment s ON s.id = p.sourceId AND s.supplierId = ${supplierId}
        WHERE t.shopId = ${shopId} AND t.account = 'ACCOUNTS_PAYABLE' AND t.type = 'DEBIT'
      `,
    ]);
    const dec = (rows: Array<{ total: unknown }>) => new Prisma.Decimal(String(rows[0]?.total ?? 0));
    return supplier.openingPayables.plus(dec(receipts)).minus(dec(returns)).minus(dec(payments)).toDecimalPlaces(2);
  }
}

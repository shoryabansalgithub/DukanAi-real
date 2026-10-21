import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma, TenderType } from '@prisma/client';
import { LedgerPosting, LedgerPostingResult, LedgerPostingService } from './ledger-posting.service';
import { applyCashPayout, lockShiftForCashPayout } from '../shifts/cash-payout';

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
  payment: { id: string; amount: Prisma.Decimal; tender: TenderType; supplierId: string; vendorBillId: string | null; shiftId: string | null; createdAt: Date };
  pendingPayables: Prisma.Decimal;
  replayed: boolean;
}

export interface LockedSupplier {
  id: string;
  pendingPayables: Prisma.Decimal;
  isDeleted: boolean;
}

/**
 * Accounts payable per supplier (roadmap 3.11, audit P2-24, release audit
 * S3/S11/S17). The ledger's ACCOUNTS_PAYABLE account is the authority;
 * `Supplier.pendingPayables` is the per-supplier running balance maintained
 * in the same transaction as every posting that moves it:
 *   opening balance    DR OPENING_BALANCE_EQUITY / CR AP   pendingPayables = opening
 *   goods receipt      DR INVENTORY / CR AP                 pendingPayables += net value
 *   vendor bill posted DR INPUT_GST (+ DR/CR INVENTORY price difference) / CR AP   += tax + difference
 *   purchase return    DR AP / CR INVENTORY                 pendingPayables -= value
 *   credit note issued DR AP / CR INVENTORY, INPUT_GST      pendingPayables -= value
 *   supplier payment   DR AP / CR CASH|BANK                 pendingPayables -= amount (guarded)
 * A balance below zero is a supplier advance (goods returned after they were
 * paid for): it is kept, never floored, so the column always equals the
 * ledger. Lock order (AGENTS.md): Shift, then Supplier, then the ledger
 * balances; every writer here locks the supplier row before it posts.
 */
@Injectable()
export class SupplierPayablesService {
  constructor(private readonly ledger: LedgerPostingService) {}

  /** Locks the supplier row (`FOR UPDATE`); 404 when it is not this shop's (or deleted, unless `allowDeleted`). */
  async lockSupplier(tx: Prisma.TransactionClient, shopId: string, supplierId: string, options: { allowDeleted?: boolean } = {}): Promise<LockedSupplier> {
    const rows = await tx.$queryRaw<Array<{ id: string; pendingPayables: unknown; isDeleted: number | boolean }>>`
      SELECT id, pendingPayables, isDeleted FROM Supplier WHERE id = ${supplierId} AND shopId = ${shopId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row || (Boolean(row.isDeleted) && !options.allowDeleted)) throw new NotFoundException({ message: 'Supplier not found.', code: 'SUPPLIER_NOT_FOUND' });
    return { id: row.id, pendingPayables: new Prisma.Decimal(String(row.pendingPayables)), isDeleted: Boolean(row.isDeleted) };
  }

  /**
   * One posting that moves a supplier's payable: the supplier row is locked
   * first, then the posting is written, then `pendingPayables` moves by
   * `payableDelta` (the posting's net CREDIT to ACCOUNTS_PAYABLE; negative
   * for a debit). A replayed source posts nothing and moves nothing.
   * Documents of a supplier that was deleted later (a receipt accepted after
   * the supplier left) still settle: `allowDeleted`.
   */
  async postWithPayable(
    tx: Prisma.TransactionClient,
    supplierId: string | null | undefined,
    posting: LedgerPosting,
    payableDelta: Prisma.Decimal,
  ): Promise<LedgerPostingResult> {
    if (supplierId) await this.lockSupplier(tx, posting.shopId, supplierId, { allowDeleted: true });
    const result = await this.ledger.post(tx, posting);
    if (result.posted && supplierId && !payableDelta.isZero()) await this.movePayable(tx, posting.shopId, supplierId, payableDelta);
    return result;
  }

  /** Goods received on credit: the supplier is owed `value` more (caller holds the supplier lock). */
  async addPayable(tx: Prisma.TransactionClient, shopId: string, supplierId: string | null | undefined, value: Prisma.Decimal): Promise<void> {
    if (!supplierId || value.lessThanOrEqualTo(0)) return;
    await this.movePayable(tx, shopId, supplierId, value);
  }

  /** Goods sent back: the supplier is owed `value` less; below zero is an advance, never floored. */
  async reducePayable(tx: Prisma.TransactionClient, shopId: string, supplierId: string | null | undefined, value: Prisma.Decimal): Promise<void> {
    if (!supplierId || value.lessThanOrEqualTo(0)) return;
    await this.movePayable(tx, shopId, supplierId, value.negated());
  }

  private async movePayable(tx: Prisma.TransactionClient, shopId: string, supplierId: string, delta: Prisma.Decimal): Promise<void> {
    await tx.supplier.updateMany({ where: { id: supplierId, shopId }, data: { pendingPayables: { increment: delta.toDecimalPlaces(2) } } });
  }

  /**
   * Records a payment, settles it against the payable and posts it, all
   * inside `tx` (which should be READ COMMITTED: the replay lookup runs after
   * the supplier lock and must see a twin request's committed payment). A
   * CASH payment by someone with an open shift leaves that drawer
   * (`Shift.cashPayouts`, `SupplierPayment.shiftId`).
   */
  async pay(tx: Prisma.TransactionClient, input: SupplierPaymentInput): Promise<SupplierPaymentOutcome> {
    const amount = new Prisma.Decimal(input.amount.toString()).toDecimalPlaces(2);
    if (amount.lessThanOrEqualTo(0)) throw new ConflictException({ message: 'A payment must be greater than zero.', code: 'PAYMENT_INVALID' });
    const tender = input.tender ?? TenderType.CASH;

    // Canonical lock order: the drawer, then the supplier, then (in ledger.post) the account balances.
    const shiftId = tender === TenderType.CASH && input.recordedById ? await lockShiftForCashPayout(tx, input.shopId, input.recordedById) : null;
    const supplier = await this.lockSupplier(tx, input.shopId, input.supplierId);

    if (input.idempotencyKey) {
      // After the supplier lock: two requests with one key queue on the row, and the second sees the first's payment.
      const existing = await tx.supplierPayment.findFirst({ where: { shopId: input.shopId, idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const sameRequest = existing.supplierId === input.supplierId && existing.amount.equals(amount) && (existing.vendorBillId ?? null) === (input.vendorBillId ?? null);
        if (!sameRequest) {
          throw new ConflictException({ message: 'This idempotency key was already used for a different payment.', code: 'IDEMPOTENCY_KEY_REUSED', details: { paymentId: existing.id } });
        }
        return { payment: existing, pendingPayables: supplier.pendingPayables, replayed: true };
      }
    }

    // Guarded decrement: the row is locked and the balance must cover the payment.
    const now = new Date(); // application clock, UTC (roadmap 8.2)
    const settled = await tx.$executeRaw`
      UPDATE Supplier SET pendingPayables = pendingPayables - ${amount.toFixed(2)}, updatedAt = ${now}
      WHERE id = ${input.supplierId} AND shopId = ${input.shopId} AND pendingPayables >= ${amount.toFixed(2)}
    `;
    if (settled === 0) {
      throw new ConflictException({
        message: 'The payment exceeds what is owed to this supplier.',
        code: 'PAYABLES_INSUFFICIENT',
        details: { pendingPayables: supplier.pendingPayables.toFixed(2), requested: amount.toFixed(2) },
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
        shiftId,
      },
    });
    await applyCashPayout(tx, shiftId, amount);
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
    const after = await tx.supplier.findFirstOrThrow({ where: { id: input.supplierId, shopId: input.shopId }, select: { pendingPayables: true } });
    return { payment, pendingPayables: after.pendingPayables, replayed: false };
  }

  /**
   * The balance the ledger implies for one supplier: `openingPayables` (the
   * column is the authority for the opening part: suppliers created before
   * the opening balance was posted have no posting, newer ones have one with
   * the same amount, which is therefore not counted again) plus the net
   * ACCOUNTS_PAYABLE credit of every posting whose source document belongs to
   * the supplier: goods receipts, vendor bills, purchase returns, credit
   * notes and payments. Equals `Supplier.pendingPayables` when the books are
   * consistent; a mismatch points at a write that bypassed this service.
   */
  async payablesFromLedger(db: Prisma.TransactionClient, shopId: string, supplierId: string): Promise<Prisma.Decimal> {
    const supplier = await db.supplier.findFirstOrThrow({ where: { id: supplierId, shopId }, select: { openingPayables: true } });
    const rows = await db.$queryRaw<Array<{ total: unknown }>>`
      SELECT COALESCE(SUM(CASE WHEN t.type = 'CREDIT' THEN t.amount ELSE -t.amount END), 0) AS total
      FROM LedgerTransaction t
      JOIN LedgerPosting p ON p.id = t.postingId
      WHERE t.shopId = ${shopId} AND t.account = 'ACCOUNTS_PAYABLE' AND (
        (p.sourceType = 'GRN' AND p.sourceId IN (SELECT id FROM GoodsReceipt WHERE shopId = ${shopId} AND supplierId = ${supplierId}))
        OR (p.sourceType = 'VENDOR_BILL' AND p.sourceId IN (SELECT id FROM VendorBill WHERE shopId = ${shopId} AND supplierId = ${supplierId}))
        OR (p.sourceType = 'PURCHASE_RETURN' AND p.sourceId IN (SELECT id FROM PurchaseReturn WHERE shopId = ${shopId} AND supplierId = ${supplierId}))
        OR (p.sourceType = 'SUPPLIER_CREDIT_NOTE' AND p.sourceId IN (SELECT id FROM SupplierCreditNote WHERE shopId = ${shopId} AND supplierId = ${supplierId}))
        OR (p.sourceType = 'SUPPLIER_PAYMENT' AND p.sourceId IN (SELECT id FROM SupplierPayment WHERE shopId = ${shopId} AND supplierId = ${supplierId}))
      )
    `;
    return supplier.openingPayables.plus(new Prisma.Decimal(String(rows[0]?.total ?? 0))).toDecimalPlaces(2);
  }
}

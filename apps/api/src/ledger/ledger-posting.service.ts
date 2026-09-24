import { Injectable } from '@nestjs/common';
import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';

export interface LedgerEntryInput {
  account: LedgerAccount;
  type: LedgerEntryType;
  amount: Prisma.Decimal | string | number;
  description?: string;
}

/** Business events that post to the ledger; with `sourceId` they form the posting's unique key. */
export type LedgerSourceType =
  | 'SALE'
  | 'RETURN'
  | 'CANCELLATION'
  | 'CUSTOMER_PAYMENT'
  | 'GRN'
  | 'PURCHASE_RETURN'
  | 'ADJUSTMENT_REQUEST'
  | 'STOCK_ADJUSTMENT';

export interface LedgerPosting {
  shopId: string;
  /** Idempotency key: at most one posting per (shop, source type, source id), enforced by a unique index. */
  source: { type: LedgerSourceType; id: string };
  invoiceId?: string | null;
  description: string;
  entries: LedgerEntryInput[];
}

export interface LedgerPostingResult {
  /** false when this source was already posted (a replay); nothing was written. */
  posted: boolean;
  postingId: string | null;
}

/** Accounts whose balance grows with debits (assets / expenses). */
const DEBIT_NORMAL: ReadonlySet<LedgerAccount> = new Set<LedgerAccount>([
  LedgerAccount.CASH,
  LedgerAccount.BANK,
  LedgerAccount.ACCOUNTS_RECEIVABLE,
  LedgerAccount.UDHAR_RECEIVABLE,
  LedgerAccount.COST_OF_GOODS,
  LedgerAccount.INVENTORY,
  LedgerAccount.INVENTORY_ADJUSTMENT,
]);

/**
 * Double-entry posting with deterministic running balances.
 *
 * Every posting must balance (Σ debits == Σ credits) and carries a business
 * `source` key. A `LedgerPosting` header row with a unique
 * (shopId, sourceType, sourceId) index is written first: a replay of an
 * already-posted source is detected by that indexed key and skipped, and two
 * concurrent postings of the same source cannot both commit (the second
 * insert fails on the unique index and its transaction rolls back). For each
 * entry the per-account `LedgerAccountBalance` row is locked (`FOR UPDATE`,
 * always in account-name order to avoid deadlocks), updated, and the
 * resulting balance is stamped on the immutable `LedgerTransaction` row.
 */
@Injectable()
export class LedgerPostingService {
  async post(tx: Prisma.TransactionClient, posting: LedgerPosting): Promise<LedgerPostingResult> {
    const entries = posting.entries
      .map((e) => ({ ...e, amount: new Prisma.Decimal(e.amount.toString()).toDecimalPlaces(2) }))
      .filter((e) => e.amount.greaterThan(0));
    if (entries.length === 0) return { posted: false, postingId: null };

    const key = { shopId: posting.shopId, sourceType: posting.source.type, sourceId: posting.source.id };
    const existing = await tx.ledgerPosting.findUnique({ where: { shopId_sourceType_sourceId: key }, select: { id: true } });
    if (existing) return { posted: false, postingId: existing.id };

    const debits = entries.filter((e) => e.type === LedgerEntryType.DEBIT).reduce((a, e) => a.plus(e.amount), new Prisma.Decimal(0));
    const credits = entries.filter((e) => e.type === LedgerEntryType.CREDIT).reduce((a, e) => a.plus(e.amount), new Prisma.Decimal(0));
    if (!debits.equals(credits)) {
      throw new Error(`Unbalanced ledger posting for ${posting.description}: debits ${debits} != credits ${credits}`);
    }

    // The unique index is the guard: a concurrent posting of the same source fails here (P2002).
    const header = await tx.ledgerPosting.create({ data: { ...key, description: posting.description }, select: { id: true } });

    const sorted = [...entries].sort((a, b) => a.account.localeCompare(b.account));
    const balances = await this.lockBalances(tx, posting.shopId, sorted.map((e) => e.account));

    for (const entry of sorted) {
      const current = balances.get(entry.account)!;
      const grows = DEBIT_NORMAL.has(entry.account) ? entry.type === LedgerEntryType.DEBIT : entry.type === LedgerEntryType.CREDIT;
      const next = grows ? current.plus(entry.amount) : current.minus(entry.amount);
      balances.set(entry.account, next);

      await tx.$executeRaw`
        UPDATE LedgerAccountBalance SET balance = ${next.toFixed(2)}, updatedAt = NOW(3)
        WHERE shopId = ${posting.shopId} AND account = ${entry.account}
      `;
      await tx.ledgerTransaction.create({
        data: {
          shopId: posting.shopId,
          invoiceId: posting.invoiceId ?? null,
          account: entry.account,
          type: entry.type,
          amount: entry.amount,
          balanceAfter: next,
          description: entry.description ?? posting.description,
          postingId: header.id,
        },
      });
    }
    return { posted: true, postingId: header.id };
  }

  private async lockBalances(tx: Prisma.TransactionClient, shopId: string, accounts: LedgerAccount[]): Promise<Map<LedgerAccount, Prisma.Decimal>> {
    const unique = Array.from(new Set(accounts)).sort();
    for (const account of unique) {
      await tx.$executeRaw`
        INSERT INTO LedgerAccountBalance (id, shopId, account, balance, updatedAt)
        VALUES (${`${shopId}:${account}`.slice(0, 191)}, ${shopId}, ${account}, 0, NOW(3))
        ON DUPLICATE KEY UPDATE balance = balance
      `;
    }
    const rows = await tx.$queryRaw<Array<{ account: LedgerAccount; balance: Prisma.Decimal | string }>>`
      SELECT account, balance FROM LedgerAccountBalance
      WHERE shopId = ${shopId} AND account IN (${Prisma.join(unique)})
      ORDER BY account
      FOR UPDATE
    `;
    const map = new Map<LedgerAccount, Prisma.Decimal>();
    for (const row of rows) map.set(row.account, new Prisma.Decimal(row.balance.toString()));
    for (const account of unique) if (!map.has(account)) map.set(account, new Prisma.Decimal(0));
    return map;
  }
}

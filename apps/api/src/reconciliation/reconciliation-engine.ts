import { InvoiceStatus, InvoiceType, LedgerAccount, LedgerEntryType, Prisma, TenderType, UdharTransaction, UdharTransactionType } from '@prisma/client';
import { completedInvoiceFilter, IS_RETURN, IS_SALE, toDecimal } from '../analytics-domain/engines/invoice-sql';
import { splitRevenue } from '../billing/billing.types';
import { businessDateString, endOfBusinessDay, parseBusinessDate, startOfBusinessDay } from '../common/time/business-day';
import { DEBIT_NORMAL } from '../ledger/ledger-posting.service';

/**
 * Financial reconciliation of one shop's business day, to the paisa
 * (roadmap 9.5). Pure over a Prisma client: the nightly cron, the on-demand
 * route and `npm run reconcile` all call `reconcileBusinessDay` and persist
 * what it returns. Every query names the shop explicitly, so the engine runs
 * the same under a tenant context (where the extension narrows it again) and
 * on a bare client.
 *
 * Seven checks, each with its figures and a list of drifts (a drift names the
 * document or row, the two figures and their difference):
 *
 *  - documents: every invoice of the day is internally consistent
 *    (`taxable + tax + round-off = total`, tenders + credit = total) and
 *    every repayment moved the customer balance by its amount;
 *  - postings: every sale, return, cancellation and repayment of the day has
 *    exactly the ledger posting its stored amounts imply (cash and bank by
 *    tender, receivable by credit, revenue and GST by `splitRevenue`, cost of
 *    goods from the stock movements the document caused), every posting of
 *    the day balances, and no posting points at a document that does not
 *    exist;
 *  - tenders: the day's cash, bank and receivable movements in the ledger
 *    equal the day's documents by tender;
 *  - dashboard: the figure `GET /dashboard/summary` shows for the day (the
 *    shared SQL of `RevenueEngine.totals`) equals the documents and the
 *    ledger's net revenue + GST;
 *  - shifts: every shift open during the day is rebuilt from its documents
 *    (opening cash + cash sales − cash refunds + cash repayments = expected
 *    cash, and the sales / receipts counters likewise);
 *  - stock: every inventory item's `onHand` equals its stock ledger, and
 *    every product's `currentStock` equals the sum of its items;
 *  - ledger: every account balance equals the sum of its transactions and the
 *    last transaction's running balance.
 *
 * Nothing is corrected: a drift is reported for a person to explain or fix.
 */

export type ReconciliationCheckName = 'documents' | 'postings' | 'tenders' | 'dashboard' | 'shifts' | 'stock' | 'ledger';
export type ReconciliationCheckStatus = 'CLEAN' | 'DRIFT' | 'INCONCLUSIVE';

export interface ReconciliationDrift {
  check: ReconciliationCheckName;
  /** What drifted: an invoice number, a shift id, a product, an account. */
  subject: string;
  /** Which figure of the subject. */
  detail: string;
  expected: string;
  actual: string;
  difference: string;
}

export interface ReconciliationCheck {
  name: ReconciliationCheckName;
  status: ReconciliationCheckStatus;
  figures: Record<string, string | number>;
  drifts: ReconciliationDrift[];
  notes: string[];
}

export interface ReconciliationSummary {
  businessDate: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  sales: { count: number; total: string };
  returns: { count: number; total: string };
  cancellations: { count: number; total: string };
  repayments: { count: number; total: string };
  /** Net movement of the day by tender bucket, from the documents. */
  tenders: Record<'CASH' | 'BANK' | 'UDHAR', string>;
  /** Net sales of the day as the dashboard computes it (gross sales − returns). */
  netSales: string;
  /** Ledger postings of the day by source type (POS documents and everything else). */
  postings: Record<string, number>;
  shiftsChecked: number;
  itemsChecked: number;
  productsChecked: number;
}

export interface ReconciliationReport {
  businessDate: string;
  timeZone: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'CLEAN' | 'DRIFT';
  driftCount: number;
  checks: ReconciliationCheck[];
  summary: ReconciliationSummary;
}

export interface ReconcileOptions {
  shopId: string;
  timeZone: string;
  /** `YYYY-MM-DD` in `timeZone`. */
  businessDate: string;
  now?: Date;
}

/** The slice of the Prisma client the engine reads; a transaction client and the bare client both fit. */
export type ReconciliationDb = Prisma.TransactionClient;

type D = Prisma.Decimal;
const D = Prisma.Decimal;
const ZERO = new D(0);
const money = (v: D | string | number): D => new D(v.toString()).toDecimalPlaces(2);
const fmt2 = (v: D): string => v.toFixed(2);
const fmt3 = (v: D): string => v.toFixed(3);
const sum = (values: Iterable<D>): D => {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
};

const POS_SOURCES = new Set(['SALE', 'RETURN', 'CANCELLATION', 'CUSTOMER_PAYMENT']);
const BANK_TENDERS: ReadonlySet<TenderType> = new Set<TenderType>([TenderType.UPI, TenderType.CARD, TenderType.BANK_TRANSFER]);

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: { items: true; payments: true } }>;
type RepaymentRow = UdharTransaction;
type PostingRow = Prisma.LedgerPostingGetPayload<{ include: { transactions: true } }>;

/** Debit / credit amounts per account, the shape a posting is compared in. */
type EntryMap = Map<string, D>;
const entryKey = (account: LedgerAccount, type: LedgerEntryType) => `${type} ${account}`;

class Entries {
  readonly map: EntryMap = new Map();
  add(account: LedgerAccount, type: LedgerEntryType, amount: D | string | number): this {
    const value = money(amount);
    if (value.lessThanOrEqualTo(0)) return this; // LedgerPostingService drops non-positive entries
    const key = entryKey(account, type);
    this.map.set(key, (this.map.get(key) ?? ZERO).plus(value));
    return this;
  }
  get(account: LedgerAccount, type: LedgerEntryType): D {
    return this.map.get(entryKey(account, type)) ?? ZERO;
  }
  /** Signed movement of an account: debits − credits. */
  net(account: LedgerAccount): D {
    return this.get(account, LedgerEntryType.DEBIT).minus(this.get(account, LedgerEntryType.CREDIT));
  }
}

function postingEntries(posting: PostingRow | undefined): Entries {
  const entries = new Entries();
  for (const t of posting?.transactions ?? []) entries.add(t.account, t.type, t.amount);
  return entries;
}

/** Cash / bank split of an invoice's payment rows, with the legacy fallback (no rows: `paidAmount` under `paymentMode`). */
function invoiceTenders(invoice: InvoiceRow): { cash: D; bank: D } {
  let cash = ZERO;
  let bank = ZERO;
  for (const p of invoice.payments) {
    if (p.tender === TenderType.CASH) cash = cash.plus(p.amount);
    else if (BANK_TENDERS.has(p.tender)) bank = bank.plus(p.amount);
  }
  if (invoice.payments.length === 0 && invoice.paidAmount.greaterThan(0)) {
    if (invoice.paymentMode === 'UPI' || invoice.paymentMode === 'CARD') bank = bank.plus(invoice.paidAmount);
    else cash = cash.plus(invoice.paidAmount);
  }
  return { cash: money(cash), bank: money(bank) };
}

/** Per-tender split for the shift counters (UPI and CARD/BANK_TRANSFER apart). */
function invoiceTenderBuckets(invoice: InvoiceRow): { cash: D; upi: D; card: D } {
  let cash = ZERO;
  let upi = ZERO;
  let card = ZERO;
  for (const p of invoice.payments) {
    if (p.tender === TenderType.CASH) cash = cash.plus(p.amount);
    else if (p.tender === TenderType.UPI) upi = upi.plus(p.amount);
    else card = card.plus(p.amount);
  }
  if (invoice.payments.length === 0 && invoice.paidAmount.greaterThan(0)) {
    if (invoice.paymentMode === 'UPI') upi = upi.plus(invoice.paidAmount);
    else if (invoice.paymentMode === 'CARD') card = card.plus(invoice.paidAmount);
    else cash = cash.plus(invoice.paidAmount);
  }
  return { cash: money(cash), upi: money(upi), card: money(card) };
}

const inWindow = (instant: Date | null | undefined, start: Date, end: Date): boolean => !!instant && instant >= start && instant < end;

export async function reconcileBusinessDay(db: ReconciliationDb, options: ReconcileOptions): Promise<ReconciliationReport> {
  const { shopId, timeZone, businessDate } = options;
  const startedAt = options.now ?? new Date();
  const start = parseBusinessDate(businessDate, timeZone);
  if (!start) throw new Error(`businessDate must be YYYY-MM-DD (got ${JSON.stringify(businessDate)})`);
  const end = endOfBusinessDay(start, timeZone);
  const checks: ReconciliationCheck[] = [];
  const check = (name: ReconciliationCheckName): ReconciliationCheck => {
    const c: ReconciliationCheck = { name, status: 'CLEAN', figures: {}, drifts: [], notes: [] };
    checks.push(c);
    return c;
  };
  const drift = (c: ReconciliationCheck, subject: string, detail: string, expected: D | string, actual: D | string): void => {
    const e = typeof expected === 'string' ? expected : fmt2(expected);
    const a = typeof actual === 'string' ? actual : fmt2(actual);
    const difference = typeof expected === 'string' || typeof actual === 'string' ? '' : fmt2(actual.minus(expected));
    c.drifts.push({ check: c.name, subject, detail, expected: e, actual: a, difference });
    c.status = 'DRIFT';
  };
  const amountsDiffer = (c: ReconciliationCheck, subject: string, detail: string, expected: D, actual: D): void => {
    if (!money(expected).equals(money(actual))) drift(c, subject, detail, money(expected), money(actual));
  };

  // ---------------------------------------------------------------------------
  // The day's documents
  // ---------------------------------------------------------------------------
  const invoices: InvoiceRow[] = await db.invoice.findMany({
    where: {
      shopId,
      isDeleted: false,
      status: { in: [InvoiceStatus.COMPLETED, InvoiceStatus.CANCELLED] },
      OR: [{ createdAt: { gte: start, lt: end } }, { status: InvoiceStatus.CANCELLED, cancelledAt: { gte: start, lt: end } }],
    },
    include: { items: { where: { isDeleted: false } }, payments: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const repayments: RepaymentRow[] = await db.udharTransaction.findMany({
    where: { shopId, type: UdharTransactionType.PAYMENT, createdAt: { gte: start, lt: end } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const invoiceIds = invoices.map((i) => i.id);
  const cancelledIds = invoices.filter((i) => i.status === InvoiceStatus.CANCELLED).map((i) => i.id);

  // Credit reversed by a cancellation: the ADJUSTMENT row the cancellation wrote against the sale.
  const creditReversals = new Map<string, D>();
  if (cancelledIds.length > 0) {
    const rows = await db.udharTransaction.findMany({
      where: { shopId, type: UdharTransactionType.ADJUSTMENT, invoiceId: { in: cancelledIds } },
      select: { invoiceId: true, amount: true },
    });
    for (const r of rows) creditReversals.set(r.invoiceId!, (creditReversals.get(r.invoiceId!) ?? ZERO).plus(r.amount));
  }

  // Stock movements each document caused: cost of goods is cost × quantity
  // moved, so a service product (no movement) or a custom line contributes
  // nothing, exactly as the billing transactions computed it.
  const moved = new Map<string, D>(); // `${invoiceId}:${SALE|RETURN}:${productId}` -> |quantity|
  if (invoiceIds.length > 0) {
    const movements = await db.stockLedgerEntry.findMany({
      where: { shopId, referenceType: { in: ['SALE', 'RETURN'] }, referenceId: { in: invoiceIds } },
      select: { referenceId: true, referenceType: true, quantity: true, inventoryItem: { select: { productId: true } } },
    });
    for (const m of movements) {
      const key = `${m.referenceId}:${m.referenceType}:${m.inventoryItem.productId}`;
      moved.set(key, (moved.get(key) ?? ZERO).plus(m.quantity.abs()));
    }
  }
  const costOfGoods = (invoice: InvoiceRow, movement: 'SALE' | 'RETURN'): D =>
    money(
      sum(
        invoice.items
          .filter((item) => item.productId && !item.isCustom)
          .map((item) => item.costPrice.mul(moved.get(`${invoice.id}:${movement}:${item.productId}`) ?? ZERO)),
      ),
    );

  // Every posting of the day's documents, plus every posting created in the window (any source).
  const postingWhere: Prisma.LedgerPostingWhereInput[] = [{ createdAt: { gte: start, lt: end } }];
  if (invoiceIds.length > 0) postingWhere.push({ sourceType: { in: ['SALE', 'RETURN', 'CANCELLATION'] }, sourceId: { in: invoiceIds } });
  if (repayments.length > 0) postingWhere.push({ sourceType: 'CUSTOMER_PAYMENT', sourceId: { in: repayments.map((r) => r.id) } });
  const postings: PostingRow[] = await db.ledgerPosting.findMany({ where: { shopId, OR: postingWhere }, include: { transactions: true } });
  const postingByKey = new Map<string, PostingRow>(postings.map((p) => [`${p.sourceType}:${p.sourceId}`, p]));

  const saleInDay = (i: InvoiceRow) => i.type === InvoiceType.SALE && inWindow(i.createdAt, start, end);
  const returnInDay = (i: InvoiceRow) => i.type === InvoiceType.SALES_RETURN && i.status === InvoiceStatus.COMPLETED && inWindow(i.createdAt, start, end);
  const cancelInDay = (i: InvoiceRow) => i.status === InvoiceStatus.CANCELLED && inWindow(i.cancelledAt, start, end);

  // ---------------------------------------------------------------------------
  // 1. documents
  // ---------------------------------------------------------------------------
  {
    const c = check('documents');
    let count = 0;
    for (const invoice of invoices) {
      if (!saleInDay(invoice) && !returnInDay(invoice)) continue;
      count++;
      const label = invoice.invoiceNumber;
      amountsDiffer(c, label, 'taxable + tax + round-off = total', invoice.taxableAmount.plus(invoice.taxAmount).plus(invoice.roundOffAmount), invoice.totalAmount);
      const tendered = invoice.payments.length > 0 ? sum(invoice.payments.map((p) => p.amount)) : invoice.paidAmount;
      amountsDiffer(c, label, 'tenders + credit = total', tendered.plus(invoice.udharAmount), invoice.totalAmount);
      if (invoice.payments.length > 0) amountsDiffer(c, label, 'paid = Σ tender rows', sum(invoice.payments.map((p) => p.amount)), invoice.paidAmount);
      if (invoice.items.length === 0) drift(c, label, 'lines', 'at least one line', 'none');
    }
    for (const r of repayments) {
      count++;
      if (!r.amount.greaterThan(0)) drift(c, `repayment ${r.id}`, 'amount > 0', '> 0.00', fmt2(r.amount));
      amountsDiffer(c, `repayment ${r.id}`, 'balance before − amount = balance after', r.balanceBefore.minus(r.amount), r.balanceAfter);
    }
    c.figures = { documents: count, invoices: invoices.filter((i) => saleInDay(i) || returnInDay(i)).length, repayments: repayments.length };
  }

  // ---------------------------------------------------------------------------
  // 2. postings (per document) and 3. tenders (day totals)
  // ---------------------------------------------------------------------------
  const expectedDay = new Entries(); // what the documents imply for the day
  const actualDay = new Entries(); // what the matched POS postings hold
  let netRevenueLedger = ZERO; // CR − DR on SALES_REVENUE + GST_PAYABLE over the matched POS postings
  const postingCounts: Record<string, number> = {};
  const matchedPostings = new Set<string>();
  {
    const c = check('postings');
    const compare = (label: string, sourceType: string, sourceId: string, expected: Entries): void => {
      const key = `${sourceType}:${sourceId}`;
      const posting = postingByKey.get(key);
      matchedPostings.add(key);
      if (!posting) {
        const debits = sum([...expected.map.entries()].filter(([k]) => k.startsWith('DEBIT')).map(([, v]) => v));
        drift(c, label, `${sourceType} posting`, `posting of ${fmt2(debits)}`, 'no posting');
        return;
      }
      const actual = postingEntries(posting);
      for (const key of new Set([...expected.map.keys(), ...actual.map.keys()])) {
        const e = expected.map.get(key) ?? ZERO;
        const a = actual.map.get(key) ?? ZERO;
        if (!e.equals(a)) drift(c, label, `${sourceType} posting ${key}`, e, a);
      }
      for (const [k, v] of expected.map) expectedDay.map.set(k, (expectedDay.map.get(k) ?? ZERO).plus(v));
      for (const [k, v] of actual.map) actualDay.map.set(k, (actualDay.map.get(k) ?? ZERO).plus(v));
      for (const account of [LedgerAccount.SALES_REVENUE, LedgerAccount.GST_PAYABLE]) {
        netRevenueLedger = netRevenueLedger.plus(actual.get(account, LedgerEntryType.CREDIT)).minus(actual.get(account, LedgerEntryType.DEBIT));
      }
    };

    for (const invoice of invoices) {
      const label = invoice.invoiceNumber;
      if (saleInDay(invoice)) {
        const { cash, bank } = invoiceTenders(invoice);
        const { revenue, gst } = splitRevenue(invoice.taxableAmount, invoice.taxAmount, invoice.roundOffAmount);
        const cogs = costOfGoods(invoice, 'SALE');
        const expected = new Entries()
          .add(LedgerAccount.CASH, LedgerEntryType.DEBIT, cash)
          .add(LedgerAccount.BANK, LedgerEntryType.DEBIT, bank)
          .add(LedgerAccount.ACCOUNTS_RECEIVABLE, LedgerEntryType.DEBIT, invoice.udharAmount)
          .add(LedgerAccount.SALES_REVENUE, LedgerEntryType.CREDIT, revenue)
          .add(LedgerAccount.GST_PAYABLE, LedgerEntryType.CREDIT, gst)
          .add(LedgerAccount.COST_OF_GOODS, LedgerEntryType.DEBIT, cogs)
          .add(LedgerAccount.INVENTORY, LedgerEntryType.CREDIT, cogs);
        compare(label, 'SALE', invoice.id, expected);
      }
      if (returnInDay(invoice)) {
        const { cash, bank } = invoiceTenders(invoice);
        const { revenue, gst } = splitRevenue(invoice.taxableAmount, invoice.taxAmount, invoice.roundOffAmount);
        const cogs = costOfGoods(invoice, 'RETURN');
        const expected = new Entries()
          .add(LedgerAccount.SALES_REVENUE, LedgerEntryType.DEBIT, revenue)
          .add(LedgerAccount.GST_PAYABLE, LedgerEntryType.DEBIT, gst)
          .add(LedgerAccount.CASH, LedgerEntryType.CREDIT, cash)
          .add(LedgerAccount.BANK, LedgerEntryType.CREDIT, bank)
          .add(LedgerAccount.ACCOUNTS_RECEIVABLE, LedgerEntryType.CREDIT, invoice.udharAmount)
          .add(LedgerAccount.INVENTORY, LedgerEntryType.DEBIT, cogs)
          .add(LedgerAccount.COST_OF_GOODS, LedgerEntryType.CREDIT, cogs);
        compare(label, 'RETURN', invoice.id, expected);
      }
      if (cancelInDay(invoice)) {
        // Refunded the way it was paid; credit already repaid comes back as cash.
        const creditReversed = money(creditReversals.get(invoice.id) ?? ZERO);
        const repaidCredit = D.max(invoice.udharAmount.minus(creditReversed), 0);
        const { cash, bank } = invoiceTenders(invoice);
        const { revenue, gst } = splitRevenue(invoice.taxableAmount, invoice.taxAmount, invoice.roundOffAmount);
        const cogs = costOfGoods(invoice, 'RETURN');
        const expected = new Entries()
          .add(LedgerAccount.SALES_REVENUE, LedgerEntryType.DEBIT, revenue)
          .add(LedgerAccount.GST_PAYABLE, LedgerEntryType.DEBIT, gst)
          .add(LedgerAccount.CASH, LedgerEntryType.CREDIT, cash.plus(repaidCredit))
          .add(LedgerAccount.BANK, LedgerEntryType.CREDIT, bank)
          .add(LedgerAccount.ACCOUNTS_RECEIVABLE, LedgerEntryType.CREDIT, creditReversed)
          .add(LedgerAccount.INVENTORY, LedgerEntryType.DEBIT, cogs)
          .add(LedgerAccount.COST_OF_GOODS, LedgerEntryType.CREDIT, cogs);
        compare(label, 'CANCELLATION', invoice.id, expected);
      }
    }
    for (const r of repayments) {
      const expected = new Entries()
        .add(r.tender === TenderType.CASH ? LedgerAccount.CASH : LedgerAccount.BANK, LedgerEntryType.DEBIT, r.amount)
        .add(LedgerAccount.ACCOUNTS_RECEIVABLE, LedgerEntryType.CREDIT, r.amount);
      compare(`repayment ${r.id}`, 'CUSTOMER_PAYMENT', r.id, expected);
    }

    // Every posting of the day balances; a POS posting must have its document.
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));
    const repaymentIds = new Set(repayments.map((r) => r.id));
    for (const posting of postings) {
      postingCounts[posting.sourceType] = (postingCounts[posting.sourceType] ?? 0) + 1;
      const entries = postingEntries(posting);
      const debits = sum([...entries.map.entries()].filter(([k]) => k.startsWith('DEBIT')).map(([, v]) => v));
      const credits = sum([...entries.map.entries()].filter(([k]) => k.startsWith('CREDIT')).map(([, v]) => v));
      const label = `${posting.sourceType}:${posting.sourceId}`;
      if (posting.transactions.length === 0) drift(c, label, 'posting rows', 'balanced entries', 'no LedgerTransaction rows');
      else if (!debits.equals(credits)) drift(c, label, 'debits = credits', debits, credits);
      if (!POS_SOURCES.has(posting.sourceType) || matchedPostings.has(label)) continue;
      // A POS posting created in the window for a document outside the day's
      // set: it must at least point at a real document of the right kind.
      if (posting.sourceType === 'CUSTOMER_PAYMENT') {
        if (repaymentIds.has(posting.sourceId)) continue;
        const row = await db.udharTransaction.findFirst({ where: { shopId, id: posting.sourceId, type: UdharTransactionType.PAYMENT }, select: { id: true } });
        if (!row) drift(c, label, 'source document', 'a PAYMENT UdharTransaction', 'missing');
      } else {
        const known = invoiceById.get(posting.sourceId);
        const row = known ?? (await db.invoice.findFirst({ where: { shopId, id: posting.sourceId, isDeleted: false }, select: { id: true, type: true, status: true } }));
        if (!row) drift(c, label, 'source document', 'an invoice', 'missing');
        else if (posting.sourceType === 'SALE' && row.type !== InvoiceType.SALE) drift(c, label, 'source document', 'a SALE invoice', `a ${row.type} invoice`);
        else if (posting.sourceType === 'RETURN' && row.type !== InvoiceType.SALES_RETURN) drift(c, label, 'source document', 'a SALES_RETURN invoice', `a ${row.type} invoice`);
        else if (posting.sourceType === 'CANCELLATION' && row.status !== InvoiceStatus.CANCELLED) drift(c, label, 'source document', 'a CANCELLED invoice', `a ${row.status} invoice`);
      }
    }
    c.figures = { postingsCompared: matchedPostings.size, postingsInWindow: postings.length };
  }

  {
    const c = check('tenders');
    for (const account of [LedgerAccount.CASH, LedgerAccount.BANK, LedgerAccount.ACCOUNTS_RECEIVABLE]) {
      const expected = expectedDay.net(account);
      const actual = actualDay.net(account);
      c.figures[account] = fmt2(expected);
      amountsDiffer(c, account, 'documents by tender = ledger movement', expected, actual);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. dashboard
  // ---------------------------------------------------------------------------
  const salesOfDay = invoices.filter((i) => i.type === InvoiceType.SALE && i.status === InvoiceStatus.COMPLETED && inWindow(i.createdAt, start, end));
  const returnsOfDay = invoices.filter(returnInDay);
  const cancellationsOfDay = invoices.filter(cancelInDay);
  const grossFromDocuments = money(sum(salesOfDay.map((i) => i.totalAmount)));
  const returnsFromDocuments = money(sum(returnsOfDay.map((i) => i.totalAmount)));
  let netSales = grossFromDocuments.minus(returnsFromDocuments);
  {
    const c = check('dashboard');
    const rows = await db.$queryRaw<Array<{ grossSales: unknown; returns: unknown; orders: unknown; returnCount: unknown }>>`
      SELECT
        COALESCE(SUM(${IS_SALE} * i.totalAmount), 0)   AS grossSales,
        COALESCE(SUM(${IS_RETURN} * i.totalAmount), 0) AS returns,
        COALESCE(SUM(${IS_SALE}), 0)                   AS orders,
        COALESCE(SUM(${IS_RETURN}), 0)                 AS returnCount
      FROM Invoice i
      WHERE ${completedInvoiceFilter(shopId, start, end)}
    `;
    const gross = money(toDecimal(rows[0]?.grossSales));
    const returns = money(toDecimal(rows[0]?.returns));
    netSales = gross.minus(returns);
    const orders = toDecimal(rows[0]?.orders).toNumber();
    const returnCount = toDecimal(rows[0]?.returnCount).toNumber();
    c.figures = { grossSales: fmt2(gross), returns: fmt2(returns), netSales: fmt2(netSales), orders, returnCount, ledgerNetRevenue: fmt2(netRevenueLedger) };
    amountsDiffer(c, 'todayGrossSales', 'dashboard = documents', grossFromDocuments, gross);
    amountsDiffer(c, 'todayReturns', 'dashboard = documents', returnsFromDocuments, returns);
    if (orders !== salesOfDay.length) drift(c, 'todayOrders', 'dashboard = documents', String(salesOfDay.length), String(orders));
    if (returnCount !== returnsOfDay.length) drift(c, 'todayReturnCount', 'dashboard = documents', String(returnsOfDay.length), String(returnCount));
    // Cancelled sales are excluded by the dashboard and net to zero in the
    // ledger (SALE posting against CANCELLATION posting), so both agree.
    amountsDiffer(c, 'todaySales', 'dashboard net sales = ledger revenue + GST', netSales, netRevenueLedger);
  }

  // ---------------------------------------------------------------------------
  // 5. shifts
  // ---------------------------------------------------------------------------
  let shiftsChecked = 0;
  {
    const c = check('shifts');
    const shifts = await db.shift.findMany({
      where: { shopId, isDeleted: false, openedAt: { lt: end }, OR: [{ closedAt: null }, { closedAt: { gte: start } }] },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    });
    shiftsChecked = shifts.length;
    if (shifts.length > 0) {
      const shiftIds = shifts.map((s) => s.id);
      const shiftInvoices: InvoiceRow[] = await db.invoice.findMany({
        where: {
          shopId,
          isDeleted: false,
          status: { in: [InvoiceStatus.COMPLETED, InvoiceStatus.CANCELLED] },
          OR: [{ shiftId: { in: shiftIds } }, { cancelledShiftId: { in: shiftIds } }],
        },
        include: { items: { where: { isDeleted: false } }, payments: true },
      });
      const shiftRepayments = await db.udharTransaction.findMany({ where: { shopId, type: UdharTransactionType.PAYMENT, shiftId: { in: shiftIds } } });
      const cancelledOnShifts = shiftInvoices.filter((i) => i.status === InvoiceStatus.CANCELLED && i.cancelledShiftId);
      const reversals = new Map<string, D>(creditReversals);
      const unknown = cancelledOnShifts.filter((i) => !reversals.has(i.id)).map((i) => i.id);
      if (unknown.length > 0) {
        const rows = await db.udharTransaction.findMany({
          where: { shopId, type: UdharTransactionType.ADJUSTMENT, invoiceId: { in: unknown } },
          select: { invoiceId: true, amount: true },
        });
        for (const r of rows) reversals.set(r.invoiceId!, (reversals.get(r.invoiceId!) ?? ZERO).plus(r.amount));
      }
      // Rows written before Invoice.cancelledShiftId / UdharTransaction.shiftId
      // existed carry NULL although they did move a drawer: a shift they may
      // have touched cannot be rebuilt and is reported inconclusive, not as drift.
      const attributionSince = await attributionBoundary(db);

      for (const shift of shifts) {
        const label = `shift ${shift.id}`;
        const closedAt = shift.closedAt ?? end;
        const legacyCancellations = await db.invoice.count({
          where: { shopId, status: InvoiceStatus.CANCELLED, cancelledShiftId: null, cancelledAt: { gte: shift.openedAt, lte: closedAt, lt: attributionSince } },
        });
        const legacyRepayments = await db.udharTransaction.count({
          where: { shopId, type: UdharTransactionType.PAYMENT, shiftId: null, createdAt: { gte: shift.openedAt, lte: closedAt, lt: attributionSince } },
        });
        if (legacyCancellations + legacyRepayments > 0) {
          c.status = c.status === 'DRIFT' ? 'DRIFT' : 'INCONCLUSIVE';
          c.notes.push(`${label}: ${legacyCancellations} cancellation(s) and ${legacyRepayments} repayment(s) recorded before drawer attribution existed overlap it; not rebuilt`);
          continue;
        }
        let expectedCash = shift.openingCash;
        let totalSales = ZERO;
        let cashSales = ZERO;
        let upiSales = ZERO;
        let cardSales = ZERO;
        let udharSales = ZERO;
        let totalReceipts = ZERO;
        for (const invoice of shiftInvoices) {
          if (invoice.type === InvoiceType.SALE && invoice.shiftId === shift.id) {
            const b = invoiceTenderBuckets(invoice);
            totalSales = totalSales.plus(invoice.totalAmount);
            cashSales = cashSales.plus(b.cash);
            upiSales = upiSales.plus(b.upi);
            cardSales = cardSales.plus(b.card);
            udharSales = udharSales.plus(invoice.udharAmount);
            expectedCash = expectedCash.plus(b.cash);
          }
          if (invoice.type === InvoiceType.SALES_RETURN && invoice.shiftId === shift.id) {
            const b = invoiceTenderBuckets(invoice);
            totalSales = totalSales.minus(invoice.totalAmount);
            cashSales = cashSales.minus(b.cash);
            upiSales = upiSales.minus(b.upi);
            cardSales = cardSales.minus(b.card);
            udharSales = udharSales.minus(invoice.udharAmount);
            expectedCash = expectedCash.minus(b.cash);
          }
          if (invoice.status === InvoiceStatus.CANCELLED && invoice.cancelledShiftId === shift.id) {
            const creditReversed = money(reversals.get(invoice.id) ?? ZERO);
            const repaidCredit = D.max(invoice.udharAmount.minus(creditReversed), 0);
            const b = invoiceTenderBuckets(invoice);
            const cashRefund = b.cash.plus(repaidCredit);
            totalSales = totalSales.minus(invoice.totalAmount);
            cashSales = cashSales.minus(cashRefund);
            upiSales = upiSales.minus(b.upi);
            cardSales = cardSales.minus(b.card);
            udharSales = udharSales.minus(creditReversed);
            expectedCash = expectedCash.minus(cashRefund);
          }
        }
        for (const r of shiftRepayments) {
          if (r.shiftId !== shift.id) continue;
          totalReceipts = totalReceipts.plus(r.amount);
          if (r.tender === TenderType.CASH) expectedCash = expectedCash.plus(r.amount);
        }
        amountsDiffer(c, label, 'expectedCash = opening + cash sales − cash refunds + cash repayments', expectedCash, shift.expectedCash);
        amountsDiffer(c, label, 'totalSales', totalSales, shift.totalSales);
        amountsDiffer(c, label, 'cashSales', cashSales, shift.cashSales);
        amountsDiffer(c, label, 'upiSales', upiSales, shift.upiSales);
        amountsDiffer(c, label, 'cardSales', cardSales, shift.cardSales);
        amountsDiffer(c, label, 'udharSales', udharSales, shift.udharSales);
        amountsDiffer(c, label, 'totalReceipts', totalReceipts, shift.totalReceipts);
        c.figures[`${label}:status`] = shift.status;
        c.figures[`${label}:expectedCash`] = fmt2(expectedCash);
        if (shift.closingCash) c.figures[`${label}:variance`] = fmt2(shift.closingCash.minus(shift.expectedCash));
      }
    }
    c.figures.shifts = shifts.length;
  }

  // ---------------------------------------------------------------------------
  // 6. stock
  // ---------------------------------------------------------------------------
  let itemsChecked = 0;
  let productsChecked = 0;
  {
    const c = check('stock');
    const items = await db.inventoryItem.findMany({
      where: { shopId, isDeleted: false },
      select: { id: true, productId: true, locationId: true, onHand: true },
      orderBy: { id: 'asc' },
    });
    itemsChecked = items.length;
    if (items.length > 0) {
      const sums = await db.stockLedgerEntry.groupBy({ by: ['inventoryItemId'], where: { shopId }, _sum: { quantity: true } });
      const ledgerByItem = new Map(sums.map((s) => [s.inventoryItemId, s._sum.quantity ?? ZERO]));
      // A stock snapshot, when one exists, replaces the entries before it
      // (the same rule as LedgerCalculationService.calculateBalanceAt).
      const snapshots = await db.stockSnapshot.findMany({ where: { shopId }, orderBy: [{ periodEnd: 'desc' }], distinct: ['inventoryItemId'] });
      for (const snapshot of snapshots) {
        const after = await db.stockLedgerEntry.aggregate({ where: { shopId, inventoryItemId: snapshot.inventoryItemId, createdAt: { gt: snapshot.periodEnd } }, _sum: { quantity: true } });
        ledgerByItem.set(snapshot.inventoryItemId, snapshot.closingBalance.plus(after._sum.quantity ?? ZERO));
      }
      const onHandByProduct = new Map<string, D>();
      for (const item of items) {
        const ledger = ledgerByItem.get(item.id) ?? ZERO;
        if (!ledger.equals(item.onHand)) {
          c.drifts.push({ check: 'stock', subject: `item ${item.id} (product ${item.productId})`, detail: 'onHand = Σ stock ledger', expected: fmt3(ledger), actual: fmt3(item.onHand), difference: fmt3(item.onHand.minus(ledger)) });
          c.status = 'DRIFT';
        }
        onHandByProduct.set(item.productId, (onHandByProduct.get(item.productId) ?? ZERO).plus(item.onHand));
      }
      const products = await db.product.findMany({ where: { shopId, id: { in: [...onHandByProduct.keys()] } }, select: { id: true, sku: true, currentStock: true } });
      productsChecked = products.length;
      for (const product of products) {
        const expected = onHandByProduct.get(product.id) ?? ZERO;
        if (!expected.equals(product.currentStock)) {
          c.drifts.push({ check: 'stock', subject: `product ${product.sku ?? product.id}`, detail: 'currentStock = Σ onHand of its items', expected: fmt3(expected), actual: fmt3(product.currentStock), difference: fmt3(product.currentStock.minus(expected)) });
          c.status = 'DRIFT';
        }
      }
    }
    c.figures = { items: itemsChecked, products: productsChecked };
  }

  // ---------------------------------------------------------------------------
  // 7. ledger
  // ---------------------------------------------------------------------------
  {
    const c = check('ledger');
    const sums = await db.ledgerTransaction.groupBy({ by: ['account', 'type'], where: { shopId }, _sum: { amount: true } });
    const expectedBalances = new Map<LedgerAccount, D>();
    for (const row of sums) {
      const amount = row._sum.amount ?? ZERO;
      const grows = DEBIT_NORMAL.has(row.account) ? row.type === LedgerEntryType.DEBIT : row.type === LedgerEntryType.CREDIT;
      expectedBalances.set(row.account, (expectedBalances.get(row.account) ?? ZERO).plus(grows ? amount : amount.neg()));
    }
    const balances = await db.ledgerAccountBalance.findMany({ where: { shopId } });
    const accounts = new Set<LedgerAccount>([...expectedBalances.keys(), ...balances.map((b) => b.account)]);
    for (const account of accounts) {
      const expected = money(expectedBalances.get(account) ?? ZERO);
      const stored = balances.find((b) => b.account === account)?.balance;
      c.figures[account] = fmt2(expected);
      if (stored === undefined) {
        if (!expected.isZero()) drift(c, account, 'LedgerAccountBalance row', fmt2(expected), 'no row');
        continue;
      }
      amountsDiffer(c, account, 'balance = Σ transactions', expected, stored);
      const last = await db.ledgerTransaction.findFirst({ where: { shopId, account }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { balanceAfter: true } });
      if (last) amountsDiffer(c, account, 'last balanceAfter = balance', last.balanceAfter, stored);
    }
    c.figures.accounts = accounts.size;
  }

  const driftCount = checks.reduce((n, c) => n + c.drifts.length, 0);
  const finishedAt = new Date();
  const summary: ReconciliationSummary = {
    businessDate,
    timeZone,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    sales: { count: salesOfDay.length, total: fmt2(grossFromDocuments) },
    returns: { count: returnsOfDay.length, total: fmt2(returnsFromDocuments) },
    cancellations: { count: cancellationsOfDay.length, total: fmt2(money(sum(cancellationsOfDay.map((i) => i.totalAmount)))) },
    repayments: { count: repayments.length, total: fmt2(money(sum(repayments.map((r) => r.amount)))) },
    tenders: {
      CASH: fmt2(expectedDay.net(LedgerAccount.CASH)),
      BANK: fmt2(expectedDay.net(LedgerAccount.BANK)),
      UDHAR: fmt2(expectedDay.net(LedgerAccount.ACCOUNTS_RECEIVABLE)),
    },
    netSales: fmt2(netSales),
    postings: postingCounts,
    shiftsChecked,
    itemsChecked,
    productsChecked,
  };
  return { businessDate, timeZone, startedAt, finishedAt, status: driftCount > 0 ? 'DRIFT' : 'CLEAN', driftCount, checks, summary };
}

/**
 * When drawer attribution started: the instant migration
 * `20261005090000_reconciliation_runs` finished on this database. Cancellations
 * and repayments older than that carry NULL shift columns although they did
 * move a drawer; newer NULLs mean no drawer was touched. Without the row (a
 * database not built by `migrate deploy`) every NULL is read as "no drawer".
 */
async function attributionBoundary(db: ReconciliationDb): Promise<Date> {
  try {
    const rows = await db.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20261005090000_reconciliation_runs' LIMIT 1
    `;
    const finished = rows[0]?.finished_at ? new Date(rows[0].finished_at) : null;
    return finished && Number.isFinite(finished.getTime()) ? finished : new Date(0);
  } catch {
    return new Date(0);
  }
}

/** The business day before the one containing `now` in `timeZone`: the day the nightly run reconciles. */
export function previousBusinessDate(now: Date, timeZone: string): string {
  return businessDateString(new Date(startOfBusinessDay(now, timeZone).getTime() - 1), timeZone);
}

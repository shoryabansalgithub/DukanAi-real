/**
 * Release audit, books and reconciliation over the real stack:
 *
 *  - L5: a run reads one database snapshot. A sale committed between two of
 *    the engine's reads (through `ReconciliationCheckpoints`) leaves the run
 *    CLEAN, while the same engine on a bare client reports the race as drift.
 *  - L6 / payouts: expenses post DR EXPENSES / CR CASH|BANK (and adjust on
 *    every edit and delete), a cash expense or a cash supplier payment leaves
 *    the recorder's open drawer, an edit after the drawer closed leaves it
 *    alone, and the shift check rebuilds the payouts from the documents.
 *  - L9: customer balances against their udhar rows and the ledger, supplier
 *    payables against their documents and the ledger, invoice totals against
 *    their lines, credit sales against their CREDIT rows, each detected with a
 *    deliberately corrupted row; a supplier whose opening balance predates its
 *    posting is INCONCLUSIVE, not drift.
 */
import { INestApplication } from '@nestjs/common';
import { LedgerAccount, Prisma, ReconciliationTrigger, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../../src/billing/billing.service';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { reconcileBusinessDay, ReconciliationCheck, ReconciliationCheckName, ReconciliationProbePoint } from '../../src/reconciliation/reconciliation-engine';
import { ReconciliationCheckpoints } from '../../src/reconciliation/reconciliation-checkpoints';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { businessDateString } from '../../src/common/time/business-day';
import { httpAs, ownerOf } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';

describe('books and reconciliation (release audit L5, L6, L9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let customers: CustomersService;
  let shifts: ShiftsService;
  let recon: ReconciliationService;
  let run: ReturnType<typeof tenantRunner>;
  /** What the overridden checkpoints do at each point of the next run. */
  let atCheckpoint: Partial<Record<ReconciliationProbePoint, () => Promise<void>>> = {};

  const check = (checks: ReconciliationCheck[], name: ReconciliationCheckName) => checks.find((c) => c.name === name)!;
  const owner = (s: TestShop) => actorFor(s, s.ownerId, Role.OWNER);
  const asOwner = <T>(s: TestShop, fn: () => Promise<T>) => run.as(s.shopId, s.ownerId, Role.OWNER, fn);
  const reconcile = (s: TestShop) => asOwner(s, () => recon.runForShop(s.shopId, { trigger: ReconciliationTrigger.MANUAL }));
  const sell = (s: TestShop, productId: string, quantity: number, amount: number, extra: Record<string, unknown> = {}) =>
    asOwner(s, () =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity }], payments: [{ tender: TenderType.CASH, amount }], ...extra } as never, owner(s)),
    );
  const expectDrift = (checks: ReconciliationCheck[], name: ReconciliationCheckName, subject: string, detail: string) => {
    const c = check(checks, name);
    expect(c.status).toBe('DRIFT');
    const found = c.drifts.find((d) => d.subject.includes(subject) && d.detail.includes(detail));
    expect({ check: name, subject, detail, found: !!found, drifts: found ? undefined : c.drifts }).toMatchObject({ found: true });
    return found!;
  };

  beforeAll(async () => {
    app = await bootApp((builder) =>
      builder.overrideProvider(ReconciliationCheckpoints).useValue({
        reach: async (point: ReconciliationProbePoint) => {
          const work = atCheckpoint[point];
          delete atCheckpoint[point];
          if (work) await work();
        },
      }),
    );
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    customers = app.get(CustomersService);
    shifts = app.get(ShiftsService);
    recon = app.get(ReconciliationService);
    run = tenantRunner(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('L5: one snapshot per run', () => {
    let shop: TestShop;
    let tea: string;

    beforeAll(async () => {
      shop = await createShop(app, 'snap');
      tea = await createProduct(app, shop, { key: 'tea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
      await receiveStock(app, shop, tea, 50);
      await sell(shop, tea, 1, 118);
    });

    it('a sale committed between the engine reads leaves the run CLEAN', async () => {
      const before = await run.system(() => prisma.invoice.count({ where: { shopId: shop.shopId } }));
      // One sale after the documents are read, one between the stock items and their ledger, one between the account sums and the balances.
      atCheckpoint = {
        'documents-read': async () => void (await sell(shop, tea, 1, 118)),
        'stock-items-read': async () => void (await sell(shop, tea, 2, 236)),
        'ledger-sums-read': async () => void (await sell(shop, tea, 1, 118)),
      };
      const result = await reconcile(shop);
      expect(atCheckpoint).toEqual({}); // every checkpoint was reached and its sale committed
      expect(await run.system(() => prisma.invoice.count({ where: { shopId: shop.shopId } }))).toBe(before + 3);
      expect({ status: result.status, drifts: result.checks.flatMap((c) => c.drifts) }).toEqual({ status: 'CLEAN', drifts: [] });
      // The run saw the day as it stood when its snapshot opened: the first sale only.
      expect(result.summary!.sales).toEqual({ count: 1, total: '118.00' });
      // And the books now hold every sale, consistently.
      expect((await reconcile(shop)).status).toBe('CLEAN');
    });

    it('without the snapshot the same race reads as drift (what the nightly run paged on)', async () => {
      const businessDate = businessDateString(new Date(), TZ);
      const report = await asOwner(shop, () =>
        reconcileBusinessDay(prisma, {
          shopId: shop.shopId,
          timeZone: TZ,
          businessDate,
          probe: async (point) => {
            if (point === 'stock-items-read') await sell(shop, tea, 1, 118);
          },
        }),
      );
      expect(report.status).toBe('DRIFT');
      expectDrift(report.checks, 'stock', 'item ', 'onHand = Σ stock ledger');
    });
  });

  describe('L6: expenses in the books and the drawer', () => {
    let shop: TestShop;
    let owner$: Awaited<ReturnType<typeof httpAs>>;
    let shiftId: string;
    const ids: Record<string, string> = {};
    const expenseRow = (id: string) => run.system(() => prisma.expense.findUniqueOrThrow({ where: { id } }));
    const shiftRow = () => run.system(() => prisma.shift.findUniqueOrThrow({ where: { id: shiftId } }));
    const postingsOf = (id: string) =>
      run.system(() =>
        prisma.ledgerPosting.findMany({
          where: { shopId: shop.shopId, OR: [{ sourceType: 'EXPENSE', sourceId: id }, { sourceType: 'EXPENSE_ADJUSTMENT', sourceId: { startsWith: `${id}:` } }] },
          include: { transactions: true },
          orderBy: { createdAt: 'asc' },
        }),
      );
    const entries = (p: { transactions: Array<{ account: string; type: string; amount: Prisma.Decimal }> }) =>
      p.transactions.map((t) => `${t.type} ${t.account} ${t.amount.toFixed(2)}`).sort();
    const balance = async (account: LedgerAccount) =>
      num((await run.system(() => prisma.ledgerAccountBalance.findUnique({ where: { shopId_account: { shopId: shop.shopId, account } } })))?.balance);

    beforeAll(async () => {
      shop = await createShop(app, 'exp');
      owner$ = await httpAs(app, shop, ownerOf(shop));
      const tea = await createProduct(app, shop, { key: 'tea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
      await receiveStock(app, shop, tea, 20);
      shiftId = (await asOwner(shop, () => shifts.open({ openingCash: 1000 }, owner(shop)))).id;
      await sell(shop, tea, 2, 236);
    });

    it('a cash expense posts DR EXPENSES / CR CASH and leaves the open drawer; other modes post to BANK and touch no drawer', async () => {
      const cash = await owner$.post('/api/expenses').send({ description: 'Tea for staff', category: 'Supplies', amount: 150 });
      expect(cash.status).toBe(201);
      ids.cash = cash.body.id;
      expect(cash.body).toMatchObject({ status: 'Paid', mode: 'Cash', paymentMode: 'Cash', amount: 150 });
      expect(await expenseRow(ids.cash)).toMatchObject({ shiftId });
      expect(await shiftRow()).toMatchObject({ cashPayouts: new Prisma.Decimal(150), expectedCash: new Prisma.Decimal(1000 + 236 - 150) });
      const [posted] = await postingsOf(ids.cash);
      expect(posted).toMatchObject({ sourceType: 'EXPENSE', sourceId: ids.cash, description: 'Expense (Cash)' });
      expect(entries(posted)).toEqual(['CREDIT CASH 150.00', 'DEBIT EXPENSES 150.00']);

      const upi = await owner$.post('/api/expenses').send({ description: 'Electricity', category: 'Utilities', amount: 400, paymentMode: 'UPI' });
      ids.upi = upi.body.id;
      expect(await expenseRow(ids.upi)).toMatchObject({ shiftId: null });
      expect(entries((await postingsOf(ids.upi))[0])).toEqual(['CREDIT BANK 400.00', 'DEBIT EXPENSES 400.00']);
      expect(num((await shiftRow()).cashPayouts)).toBe(150);

      // Every write is audited.
      const audits = await run.system(() => prisma.auditLog.findMany({ where: { shopId: shop.shopId, entity: 'Expense', entityId: { in: [ids.cash, ids.upi] } } }));
      expect(audits.map((a) => a.action).sort()).toEqual(['EXPENSE_CREATED', 'EXPENSE_CREATED']);
    });

    it('a pending expense posts nothing until it is marked paid in its own mode', async () => {
      const pending = await owner$.post('/api/expenses').send({ description: 'Internet', category: 'Utilities', amount: 75, isPaid: false, paymentMode: 'UPI' });
      ids.pending = pending.body.id;
      expect(pending.body).toMatchObject({ status: 'Pending', mode: 'Unpaid', paymentMode: 'UPI' });
      expect(await postingsOf(ids.pending)).toEqual([]);
      // What the web's "Mark as Paid" sends: the expense's own mode.
      const paid = await owner$.patch(`/api/expenses/${ids.pending}`).send({ isPaid: true, paymentMode: pending.body.paymentMode });
      expect(paid.body).toMatchObject({ status: 'Paid', mode: 'UPI' });
      expect(entries((await postingsOf(ids.pending))[0])).toEqual(['CREDIT BANK 75.00', 'DEBIT EXPENSES 75.00']);
      expect(num((await shiftRow()).cashPayouts)).toBe(150);
    });

    it('an edit while the drawer is open adjusts the drawer and posts the difference; a delete posts the reversal', async () => {
      expect((await owner$.patch(`/api/expenses/${ids.cash}`).send({ amount: 120 })).status).toBe(200);
      expect(await shiftRow()).toMatchObject({ cashPayouts: new Prisma.Decimal(120), expectedCash: new Prisma.Decimal(1000 + 236 - 120) });
      const cashPostings = await postingsOf(ids.cash);
      expect(cashPostings.map((p) => `${p.sourceType}:${p.sourceId}`)).toEqual([`EXPENSE:${ids.cash}`, `EXPENSE_ADJUSTMENT:${ids.cash}:1`]);
      expect(entries(cashPostings[1])).toEqual(['CREDIT EXPENSES 30.00', 'DEBIT CASH 30.00']);
      // A description edit moves no money.
      expect((await owner$.patch(`/api/expenses/${ids.cash}`).send({ description: 'Tea and biscuits' })).status).toBe(200);
      expect(await postingsOf(ids.cash)).toHaveLength(2);

      expect((await owner$.delete(`/api/expenses/${ids.upi}`)).status).toBe(200);
      const upiPostings = await postingsOf(ids.upi);
      expect(entries(upiPostings[1])).toEqual(['CREDIT EXPENSES 400.00', 'DEBIT BANK 400.00']);
      expect(await balance(LedgerAccount.EXPENSES)).toBe(120 + 75);

      const actions = await run.system(() => prisma.auditLog.findMany({ where: { shopId: shop.shopId, entity: 'Expense' }, select: { action: true } }));
      expect(actions.filter((a) => a.action === 'EXPENSE_UPDATED')).toHaveLength(3);
      expect(actions.filter((a) => a.action === 'EXPENSE_DELETED')).toHaveLength(1);
    });

    it('a cash supplier payment leaves the drawer too, and the day reconciles with the payouts rebuilt', async () => {
      const supplier = await owner$.post('/api/suppliers').send({ name: 'Ravi Traders', phone: `8${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '1')}`, openingBalance: 500 });
      expect(supplier.status).toBe(201);
      ids.supplier = supplier.body.id;
      const paid = await owner$.post(`/api/suppliers/${ids.supplier}/payments`).send({ amount: 200, tender: 'CASH', idempotencyKey: randomUUID() });
      expect(paid.status).toBe(201);
      expect(await run.system(() => prisma.supplierPayment.findFirstOrThrow({ where: { supplierId: ids.supplier } }))).toMatchObject({ shiftId });
      expect(num((await shiftRow()).cashPayouts)).toBe(120 + 200);

      const result = await reconcile(shop);
      expect({ status: result.status, drifts: result.checks.flatMap((c) => c.drifts), notes: result.checks.flatMap((c) => c.notes) }).toEqual({ status: 'CLEAN', drifts: [], notes: [] });
      expect(check(result.checks, 'shifts').figures).toMatchObject({ [`shift ${shiftId}:cashPayouts`]: '320.00', [`shift ${shiftId}:expectedCash`]: (1000 + 236 - 320).toFixed(2) });
      expect(check(result.checks, 'postings').figures).toMatchObject({ expensesChecked: 3 });
      expect(check(result.checks, 'payables').figures).toMatchObject({ pendingPayables: '300.00', ledger: '300.00', unpostedOpenings: 0 });
    });

    it('once the drawer is closed an edit leaves it alone, and the shift is still rebuilt from the state at its close', async () => {
      const late = await owner$.post('/api/expenses').send({ description: 'Courier', category: 'Other', amount: 50 });
      ids.late = late.body.id;
      const open = await shiftRow();
      expect(num(open.cashPayouts)).toBe(370);
      await asOwner(shop, () => shifts.close({ closingCash: num(open.expectedCash) }, owner(shop)));

      expect((await owner$.patch(`/api/expenses/${ids.late}`).send({ amount: 80 })).status).toBe(200);
      const closed = await shiftRow();
      expect({ cashPayouts: num(closed.cashPayouts), expectedCash: num(closed.expectedCash) }).toEqual({ cashPayouts: 370, expectedCash: num(open.expectedCash) });
      expect(await expenseRow(ids.late)).toMatchObject({ shiftId, amount: new Prisma.Decimal(80) });
      expect(await balance(LedgerAccount.EXPENSES)).toBe(120 + 75 + 80);

      const result = await reconcile(shop);
      expect({ status: result.status, drifts: result.checks.flatMap((c) => c.drifts), notes: result.checks.flatMap((c) => c.notes) }).toEqual({ status: 'CLEAN', drifts: [], notes: [] });
      expect(check(result.checks, 'shifts').figures).toMatchObject({ [`shift ${shiftId}:cashPayouts`]: '370.00' });
    });

    it('detects a payout that is not in the drawer and an expense the books do not match', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE Shift SET cashPayouts = cashPayouts - 10 WHERE id = ${shiftId}`);
      try {
        const result = await reconcile(shop);
        expect(expectDrift(result.checks, 'shifts', shiftId, 'cashPayouts').difference).toBe('-10.00');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Shift SET cashPayouts = cashPayouts + 10 WHERE id = ${shiftId}`);
      }
      await run.system(() => prisma.$executeRaw`UPDATE Expense SET amount = amount + 5 WHERE id = ${ids.pending}`);
      try {
        const result = await reconcile(shop);
        expectDrift(result.checks, 'postings', `expense ${ids.pending}`, 'EXPENSES');
        expectDrift(result.checks, 'postings', `expense ${ids.pending}`, 'BANK');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Expense SET amount = amount - 5 WHERE id = ${ids.pending}`);
      }
      expect((await reconcile(shop)).status).toBe('CLEAN');
    });

    it('refuses an expense dated on a day the calendar does not have', async () => {
      const res = await owner$.post('/api/expenses').send({ description: 'Bad date', category: 'Other', amount: 1, expenseDate: '2026-02-30' });
      expect(res.status).toBe(400);
      expect((await owner$.post('/api/expenses').send({ description: 'Paise', category: 'Other', amount: 10.505 })).status).toBe(400);
    });
  });

  describe('L9: receivables, payables, invoice lines and credit rows', () => {
    let shop: TestShop;
    let tea: string;
    let creditSale: { id: string; invoiceNumber: string; items: Array<{ id: string }> };
    let advanceCustomerId: string;
    let supplierId: string;

    beforeAll(async () => {
      shop = await createShop(app, 'cov', { creditLimit: 10_000 });
      tea = await createProduct(app, shop, { key: 'tea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
      await receiveStock(app, shop, tea, 20);
      const sale = await asOwner(shop, () =>
        billing.createInvoice({ idempotencyKey: randomUUID(), customerId: shop.customerId, items: [{ productId: tea, quantity: 2 }], payments: [], udharAmount: 236 } as never, owner(shop)),
      );
      creditSale = { id: sale.invoice.id, invoiceNumber: sale.invoice.invoiceNumber, items: sale.invoice.items.map((i) => ({ id: i.id })) };
      // A customer who pays ahead: an advance (negative balance).
      advanceCustomerId = (
        await run.system(() => prisma.customer.create({ data: { shopId: shop.shopId, name: 'Advance', phone: `7${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '2')}`, creditLimit: 0 } }))
      ).id;
      await asOwner(shop, () => customers.recordPayment(advanceCustomerId, { idempotencyKey: randomUUID(), amount: 100, tender: TenderType.CASH, allowAdvance: true } as never, owner(shop)));
      const owner$ = await httpAs(app, shop, ownerOf(shop));
      supplierId = (await owner$.post('/api/suppliers').send({ name: 'Supplier', phone: `6${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '3')}`, openingBalance: 250 })).body.id;
    });

    it('a clean shop: balances add up to the ledger, advances apart', async () => {
      const result = await reconcile(shop);
      expect({ status: result.status, drifts: result.checks.flatMap((c) => c.drifts) }).toEqual({ status: 'CLEAN', drifts: [] });
      expect(check(result.checks, 'receivables').figures).toMatchObject({ receivable: '236.00', advances: '100.00', net: '136.00', ledger: '136.00' });
      expect(check(result.checks, 'payables').figures).toMatchObject({ pendingPayables: '250.00', ledger: '250.00' });
    });

    it('a customer balance that is not its udhar history', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE Customer SET outstandingBalance = outstandingBalance + 1 WHERE id = ${shop.customerId}`);
      try {
        const result = await reconcile(shop);
        expectDrift(result.checks, 'receivables', `customer ${shop.customerId}`, 'Σ udhar movements');
        expectDrift(result.checks, 'receivables', `customer ${shop.customerId}`, 'last udhar row');
        expect(expectDrift(result.checks, 'receivables', 'ACCOUNTS_RECEIVABLE', 'ledger receivables')).toMatchObject({ expected: '137.00', actual: '136.00' });
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Customer SET outstandingBalance = outstandingBalance - 1 WHERE id = ${shop.customerId}`);
      }
    });

    it('a credit sale without its CREDIT udhar row', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE UdharTransaction SET invoiceId = NULL WHERE invoiceId = ${creditSale.id} AND type = 'CREDIT'`);
      try {
        const result = await reconcile(shop);
        expectDrift(result.checks, 'documents', creditSale.invoiceNumber, 'credit sale has its CREDIT udhar row');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE UdharTransaction SET invoiceId = ${creditSale.id} WHERE customerId = ${shop.customerId} AND type = 'CREDIT' AND invoiceId IS NULL`);
      }
    });

    it('an invoice whose lines do not add up to its total', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE InvoiceItem SET totalAmount = totalAmount + 0.01 WHERE id = ${creditSale.items[0].id}`);
      try {
        const result = await reconcile(shop);
        expect(expectDrift(result.checks, 'documents', creditSale.invoiceNumber, 'Σ line totals + round-off = total')).toMatchObject({ expected: '236.01', actual: '236.00' });
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE InvoiceItem SET totalAmount = totalAmount - 0.01 WHERE id = ${creditSale.items[0].id}`);
      }
    });

    it('a supplier balance that is not its documents', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE Supplier SET pendingPayables = pendingPayables + 1 WHERE id = ${supplierId}`);
      try {
        const result = await reconcile(shop);
        expectDrift(result.checks, 'payables', `supplier ${supplierId}`, 'pendingPayables = opening');
        expectDrift(result.checks, 'payables', 'ACCOUNTS_PAYABLE', 'ledger payables');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Supplier SET pendingPayables = pendingPayables - 1 WHERE id = ${supplierId}`);
      }
    });

    it('a supplier whose opening balance was never posted makes the payables INCONCLUSIVE, not drift', async () => {
      const legacy = await run.system(() =>
        prisma.supplier.create({ data: { shopId: shop.shopId, name: 'Legacy', phone: `5${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '4')}`, openingPayables: 900, pendingPayables: 900 } }),
      );
      try {
        const result = await reconcile(shop);
        const payables = check(result.checks, 'payables');
        expect({ status: payables.status, drifts: payables.drifts }).toEqual({ status: 'INCONCLUSIVE', drifts: [] });
        expect(payables.notes.join(' ')).toContain('recorded before it was posted to the ledger');
        expect(result.status).toBe('CLEAN');
      } finally {
        await run.system(() => prisma.supplier.delete({ where: { id: legacy.id } }));
      }
      expect((await reconcile(shop)).status).toBe('CLEAN');
    });
  });
});

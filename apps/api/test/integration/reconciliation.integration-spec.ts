/**
 * Financial reconciliation to the paisa (roadmap 9.5) against the real
 * database: a day of mixed sales (cash, split, credit, a service and a custom
 * line), returns, a cancellation and repayments with a closed shift
 * reconciles with zero drift and every figure of the run is checked against
 * an independent read; a deliberately corrupted row in each area (document,
 * tender row, shift, stock, account balance, orphan posting, repayment) is
 * detected and named; the owner routes and their role gate, the nightly
 * sweep under the cron lock, the metrics and the CLI.
 */
import { INestApplication } from '@nestjs/common';
import { Prisma, ReconciliationTrigger, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import * as path from 'path';
import request from 'supertest';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CronLockService } from '../../src/common/cron-lock/cron-lock.service';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { previousBusinessDate, ReconciliationCheck, ReconciliationCheckName } from '../../src/reconciliation/reconciliation-engine';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';

/** The sample value of a metric line whose labels contain every given pair. */
function sample(text: string, metric: string, labels: Record<string, string>): number | undefined {
  const lines = text.split('\n').filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
  const line = lines.find((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line ? Number(line.trim().split(' ').pop()) : undefined;
}

describe('financial reconciliation (roadmap 9.5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let shifts: ShiftsService;
  let customers: CustomersService;
  let dashboard: DashboardService;
  let recon: ReconciliationService;
  let run: ReturnType<typeof tenantRunner>;
  let shop: TestShop;
  let readers: ReturnType<typeof makeReaders>;
  const products: Record<string, string> = {};
  const invoices: Record<string, { id: string; invoiceNumber: string; items: Array<{ id: string; productId: string | null }> }> = {};
  let shiftId: string;
  let firstRunId: string;

  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);
  const owner = () => actorFor(shop, shop.ownerId, Role.OWNER);
  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const asOwner = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.ownerId, Role.OWNER, fn);
  const reconcile = (date?: string) => asOwner(() => recon.runForShop(shop.shopId, { trigger: ReconciliationTrigger.MANUAL, date }));
  const check = (checks: ReconciliationCheck[], name: ReconciliationCheckName) => checks.find((c) => c.name === name)!;
  const sell = (actor: ReturnType<typeof cashier>, dto: Record<string, unknown>) =>
    run.as(shop.shopId, actor.userId, actor.role, () => billing.createInvoice({ idempotencyKey: randomUUID(), ...dto } as never, actor));

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    shifts = app.get(ShiftsService);
    customers = app.get(CustomersService);
    dashboard = app.get(DashboardService);
    recon = app.get(ReconciliationService);
    run = tenantRunner(app);
    shop = await createShop(app, 'recon', { creditLimit: 10_000 });
    readers = makeReaders(app, shop);
    products.tea = await createProduct(app, shop, { key: 'tea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
    products.soap = await createProduct(app, shop, { key: 'soap', sellingPrice: 50, costPrice: 30, gstRate: 'FIVE' });
    products.service = await createProduct(app, shop, { key: 'svc', sellingPrice: 200, costPrice: 60, gstRate: 'EIGHTEEN', type: 'SERVICE' });
    await receiveStock(app, shop, products.tea, 50);
    await receiveStock(app, shop, products.soap, 50);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a day of mixed sales, returns, a cancellation and repayments with a closed shift reconciles with zero drift', async () => {
    shiftId = (await asCashier(() => shifts.open({ openingCash: 1000 }, cashier()))).id;

    // A: cash, two stocked lines of one product.
    const a = await sell(cashier(), { items: [{ productId: products.tea, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 236 }] });
    // B: split cash + card over two products.
    const b = await sell(cashier(), { items: [{ productId: products.tea, quantity: 1 }, { productId: products.soap, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 100 }, { tender: TenderType.CARD, amount: 123 }] });
    // C: credit sale to the customer.
    const c = await sell(cashier(), { customerId: shop.customerId, items: [{ productId: products.tea, quantity: 3 }], payments: [], udharAmount: 354 });
    // D: a service product (no stock movement, no cost of goods) and a custom line.
    const d = await sell(cashier(), {
      items: [{ productId: products.service, quantity: 1 }, { custom: { name: 'Gift wrap', unitPrice: 20, gstRate: 'ZERO' }, quantity: 1 }],
      payments: [{ tender: TenderType.CASH, amount: 256 }],
    });
    // E: cash (52.50 rounds to 53 on the invoice), cancelled the same day.
    const e = await sell(cashier(), { items: [{ productId: products.soap, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 53 }] });
    // F: the owner sells by UPI without a shift (no drawer involved).
    const f = await sell(owner(), { items: [{ productId: products.soap, quantity: 1 }], payments: [{ tender: TenderType.UPI, amount: 53 }] });
    for (const [key, result] of Object.entries({ a, b, c, d, e, f })) {
      expect(result.invoice.status).toBe('COMPLETED');
      invoices[key] = { id: result.invoice.id, invoiceNumber: result.invoice.invoiceNumber, items: result.invoice.items.map((i) => ({ id: i.id, productId: i.productId })) };
    }

    // Partial cash refund of A, credit reversal on C, cancellation of E.
    const teaLineOfA = invoices.a.items.find((i) => i.productId === products.tea)!;
    const returnA = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: invoices.a.id, items: [{ invoiceItemId: teaLineOfA.id, quantity: 1 }], refund: { tender: TenderType.CASH } }, cashier()));
    expect(num(returnA.invoice.paidAmount)).toBe(118);
    const teaLineOfC = invoices.c.items.find((i) => i.productId === products.tea)!;
    const returnC = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: invoices.c.id, items: [{ invoiceItemId: teaLineOfC.id, quantity: 1 }] }, cashier()));
    expect(num(returnC.invoice.udharAmount)).toBe(118);
    expect(num(returnC.invoice.paidAmount)).toBe(0);
    await asCashier(() => reversal.cancelInvoice(invoices.e.id, { reason: 'wrong bill' }, cashier()));

    // Two repayments, one by cash into the drawer, one by UPI.
    await asCashier(() => customers.recordPayment(shop.customerId, { idempotencyKey: randomUUID(), amount: 100, tender: TenderType.CASH }, cashier()));
    await asCashier(() => customers.recordPayment(shop.customerId, { idempotencyKey: randomUUID(), amount: 50, tender: TenderType.UPI }, cashier()));

    // The cancellation and the repayments recorded their drawer.
    const cancelled = await run.system(() => prisma.invoice.findUniqueOrThrow({ where: { id: invoices.e.id }, select: { status: true, cancelledShiftId: true } }));
    expect(cancelled).toEqual({ status: 'CANCELLED', cancelledShiftId: shiftId });
    const repayments = await run.system(() => prisma.udharTransaction.findMany({ where: { shopId: shop.shopId, type: 'PAYMENT' }, select: { shiftId: true } }));
    expect(repayments.map((r) => r.shiftId)).toEqual([shiftId, shiftId]);

    // Close the drawer on exactly the expected cash.
    const open = await asCashier(() => shifts.current(cashier()));
    expect(num(open!.expectedCash)).toBe(1000 + 236 + 100 + 256 + 53 - 118 - 53 + 100);
    const closed = await asCashier(() => shifts.close({ closingCash: num(open!.expectedCash) }, cashier()));
    expect(num(closed.variance)).toBe(0);

    const result = await reconcile();
    firstRunId = result.id;
    expect(result).toMatchObject({ status: 'CLEAN', driftCount: 0, trigger: 'MANUAL', timeZone: TZ });
    expect(result.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'documents:CLEAN',
      'postings:CLEAN',
      'tenders:CLEAN',
      'dashboard:CLEAN',
      'shifts:CLEAN',
      'stock:CLEAN',
      'ledger:CLEAN',
    ]);
    expect(result.checks.flatMap((c) => c.notes)).toEqual([]);

    // Every figure of the summary against an independent read.
    const summary = result.summary!;
    expect(summary.sales).toEqual({ count: 5, total: (236 + 223 + 354 + 256 + 53).toFixed(2) });
    expect(summary.returns).toEqual({ count: 2, total: '236.00' });
    expect(summary.cancellations).toEqual({ count: 1, total: '53.00' });
    expect(summary.repayments).toEqual({ count: 2, total: '150.00' });
    // The shop is new, so the day's movement by tender is the account balance itself.
    expect(summary.tenders).toEqual({
      CASH: (await readers.ledgerBalance('CASH')).toFixed(2),
      BANK: (await readers.ledgerBalance('BANK')).toFixed(2),
      UDHAR: (await readers.ledgerBalance('ACCOUNTS_RECEIVABLE')).toFixed(2),
    });
    expect(summary.tenders).toEqual({ CASH: '574.00', BANK: '226.00', UDHAR: '86.00' });
    expect(await readers.outstanding()).toBe(86);
    const dash = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    expect(summary.netSales).toBe(dash.todaySales!.toFixed(2));
    expect(check(result.checks, 'dashboard').figures).toMatchObject({ netSales: summary.netSales, orders: 5, returnCount: 2, ledgerNetRevenue: summary.netSales });
    // The two opening-balance receipts posted STOCK_ADJUSTMENT entries today: counted and balance-checked, not matched to a POS document.
    expect(summary.postings).toEqual({ SALE: 6, RETURN: 2, CANCELLATION: 1, CUSTOMER_PAYMENT: 2, STOCK_ADJUSTMENT: 2 });
    expect(summary).toMatchObject({ shiftsChecked: 1, itemsChecked: 2, productsChecked: 2 });
    expect(check(result.checks, 'shifts').figures).toMatchObject({ [`shift ${shiftId}:status`]: 'CLOSED', [`shift ${shiftId}:variance`]: '0.00' });
    // Six sales (the cancelled one included: its SALE posting is checked), two returns, two repayments.
    expect(check(result.checks, 'documents').figures).toEqual({ documents: 10, invoices: 8, repayments: 2 });

    const stored = await run.system(() => prisma.reconciliationRun.findMany({ where: { shopId: shop.shopId } }));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: result.id, status: 'CLEAN', driftCount: 0, trigger: 'MANUAL', businessDate: result.businessDate });
  });

  it('serves the runs to the owner, refuses a VIEWER and a foreign id, and runs on demand with a validated date', async () => {
    const http = await httpAs(app, shop, ownerOf(shop));
    const latest = await http.get('/api/reconciliation/latest').expect(200);
    expect(latest.body).toMatchObject({ id: firstRunId, status: 'CLEAN', driftCount: 0 });
    expect(latest.body.checks).toHaveLength(7);

    const list = await http.get('/api/reconciliation/runs').expect(200);
    expect(list.headers['x-total-count']).toBe('1');
    expect(list.body).toEqual([expect.objectContaining({ id: firstRunId, status: 'CLEAN' })]);
    expect(list.body[0].checks).toBeUndefined();
    await http.get(`/api/reconciliation/runs/${firstRunId}`).expect(200);
    await http.get(`/api/reconciliation/runs/${randomUUID()}`).expect(404);

    const manual = await http.post('/api/reconciliation/run').send({}).expect(201);
    expect(manual.body).toMatchObject({ status: 'CLEAN', trigger: 'MANUAL', driftCount: 0 });
    expect((await http.get('/api/reconciliation/latest').expect(200)).body.id).toBe(manual.body.id);
    expect(JSON.stringify((await http.post('/api/reconciliation/run').send({ date: 'yesterday' }).expect(400)).body.message)).toContain('date must be YYYY-MM-DD');
    expect((await http.post('/api/reconciliation/run').send({ date: '2026-13-45' }).expect(400)).body.code).toBe('RECONCILIATION_INVALID_DATE');
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await http.post('/api/reconciliation/run').send({ date: tomorrow }).expect(400)).body.code).toBe('RECONCILIATION_FUTURE_DATE');

    const viewer = await httpAs(app, shop, await createUser(app, shop, Role.VIEWER));
    await viewer.get('/api/reconciliation/latest').expect(403);
    await viewer.get('/api/reconciliation/runs').expect(403);
    await viewer.post('/api/reconciliation/run').send({}).expect(403);

    const other = await createShop(app, 'reconB', { resolveLocation: false });
    const foreign = await httpAs(app, other, ownerOf(other));
    await foreign.get(`/api/reconciliation/runs/${firstRunId}`).expect(404);
    expect((await foreign.get('/api/reconciliation/latest').expect(404)).body.code).toBe('RECONCILIATION_NOT_RUN');
  });

  it('the nightly sweep reconciles every shop for its previous business day, once, under the cron lock', async () => {
    const now = new Date();
    const summary = await recon.sweep(now);
    expect(summary).not.toBeNull();
    expect(summary!.shops).toBeGreaterThanOrEqual(1);
    expect(summary!.failed).toBe(0);
    const cron = await run.system(() => prisma.reconciliationRun.findMany({ where: { shopId: shop.shopId, trigger: 'CRON' } }));
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({ businessDate: previousBusinessDate(now, TZ), status: 'CLEAN', driftCount: 0, timeZone: TZ });
    // Yesterday had no documents; the all-time stock and ledger checks still ran.
    expect(cron[0].summary).toMatchObject({ sales: { count: 0 }, itemsChecked: 2, shiftsChecked: 0 });

    // Another instance holding the lock: nothing runs here.
    const lock = app.get(CronLockService);
    const held = await lock.withLock('cron:reconciliation', 60_000, async () => recon.sweep(now));
    expect(held).toBeNull();
    expect(await run.system(() => prisma.reconciliationRun.count({ where: { shopId: shop.shopId, trigger: 'CRON' } }))).toBe(1);
  });

  /** Shops whose newest run is not CLEAN, read the way the collector reads it (the test database holds other suites' shops too). */
  const shopsWithDrift = () =>
    run.system(async () => {
      const rows = await prisma.$queryRaw<Array<{ notClean: unknown }>>`
        SELECT COALESCE(SUM(CASE WHEN r.status <> 'CLEAN' THEN 1 ELSE 0 END), 0) AS notClean
        FROM ReconciliationRun r
        JOIN (SELECT shopId, MAX(startedAt) AS startedAt FROM ReconciliationRun GROUP BY shopId) latest
          ON latest.shopId = r.shopId AND latest.startedAt = r.startedAt
      `;
      return Number(rows[0]?.notClean ?? 0);
    });

  it('exposes the latest-run state on /api/metrics', async () => {
    const text = (await request(app.getHttpServer()).get('/api/metrics').expect(200)).text;
    expect(sample(text, 'reconciliation_shops_with_drift', {})).toBe(await shopsWithDrift());
    expect(sample(text, 'reconciliation_last_run_timestamp_seconds', {})).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 300);
    expect(sample(text, 'reconciliation_runs_total', { status: 'clean' })).toBeGreaterThanOrEqual(3);
  });

  it('runs from a checkout with npm run reconcile and records the run as CLI', async () => {
    const api = path.resolve(__dirname, '..', '..');
    const result = spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), 'scripts/reconcile.ts', '--shop', shop.shopId, '--json'], {
      cwd: api,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const parsed = JSON.parse(result.stdout) as { id: string; status: string; trigger: string; driftCount: number; shop: { id: string } };
    expect(parsed).toMatchObject({ status: 'CLEAN', trigger: 'CLI', driftCount: 0, shop: { id: shop.shopId } });
    expect(await run.system(() => prisma.reconciliationRun.count({ where: { id: parsed.id, trigger: 'CLI' } }))).toBe(1);
  });

  describe('a deliberately corrupted row is detected and named', () => {
    const expectDrift = (checks: ReconciliationCheck[], name: ReconciliationCheckName, subject: string, detail?: string) => {
      const c = check(checks, name);
      expect(c.status).toBe('DRIFT');
      expect(c.drifts).toContainEqual(expect.objectContaining({ subject: expect.stringContaining(subject), ...(detail ? { detail: expect.stringContaining(detail) } : {}) }));
      return c.drifts.find((d) => d.subject.includes(subject) && (!detail || d.detail.includes(detail)))!;
    };

    it('an edited invoice total', async () => {
      const cleanShops = await shopsWithDrift();
      await run.system(() => prisma.$executeRaw`UPDATE Invoice SET totalAmount = totalAmount + 0.01 WHERE id = ${invoices.a.id}`);
      try {
        const result = await reconcile();
        expect(result.status).toBe('DRIFT');
        const d = expectDrift(result.checks, 'documents', invoices.a.invoiceNumber, 'taxable + tax + round-off = total');
        expect(d).toMatchObject({ expected: '236.00', actual: '236.01', difference: '0.01' });
        expectDrift(result.checks, 'documents', invoices.a.invoiceNumber, 'tenders + credit = total');
        // The dashboard reads the same edited column, so it is the ledger that disagrees with it.
        expectDrift(result.checks, 'dashboard', 'todaySales', 'ledger revenue + GST');
        // The run is recorded and surfaced.
        const http = await httpAs(app, shop, ownerOf(shop));
        expect((await http.get('/api/reconciliation/latest').expect(200)).body).toMatchObject({ id: result.id, status: 'DRIFT', driftCount: result.driftCount });
        const text = (await request(app.getHttpServer()).get('/api/metrics').expect(200)).text;
        expect(sample(text, 'reconciliation_shops_with_drift', {})).toBe(cleanShops + 1);
        expect(sample(text, 'reconciliation_drift_total', { check: 'documents' })).toBeGreaterThanOrEqual(2);
        expect(sample(text, 'reconciliation_runs_total', { status: 'drift' })).toBeGreaterThanOrEqual(1);
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Invoice SET totalAmount = totalAmount - 0.01 WHERE id = ${invoices.a.id}`);
      }
    });

    it('an edited tender row', async () => {
      const card = await run.system(() => prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoices.b.id, tender: 'CARD' } }));
      await run.system(() => prisma.invoicePayment.update({ where: { id: card.id }, data: { amount: new Prisma.Decimal(122) } }));
      try {
        const result = await reconcile();
        expect(result.status).toBe('DRIFT');
        expectDrift(result.checks, 'documents', invoices.b.invoiceNumber, 'tenders + credit = total');
        const d = expectDrift(result.checks, 'postings', invoices.b.invoiceNumber, 'DEBIT BANK');
        expect(d).toMatchObject({ expected: '122.00', actual: '123.00', difference: '1.00' });
        expectDrift(result.checks, 'tenders', 'BANK');
      } finally {
        await run.system(() => prisma.invoicePayment.update({ where: { id: card.id }, data: { amount: new Prisma.Decimal(123) } }));
      }
    });

    it('an edited shift counter, also from the command line', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE Shift SET expectedCash = expectedCash + 5 WHERE id = ${shiftId}`);
      try {
        const result = await reconcile();
        const d = expectDrift(result.checks, 'shifts', shiftId, 'expectedCash');
        expect(d.difference).toBe('5.00');
        const cli = spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), 'scripts/reconcile.ts', '--shop', shop.shopId], {
          cwd: path.resolve(__dirname, '..', '..'),
          env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
          encoding: 'utf8',
          timeout: 180_000,
        });
        expect(cli.status).toBe(1);
        expect(cli.stdout).toContain(`DRIFT shift ${shiftId}: expectedCash`);
        expect(cli.stdout).toContain('DRIFT        shifts');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE Shift SET expectedCash = expectedCash - 5 WHERE id = ${shiftId}`);
      }
    });

    it('an edited stock quantity', async () => {
      const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId: products.tea, isDeleted: false } }));
      await run.system(() => prisma.$executeRaw`UPDATE InventoryItem SET onHand = onHand + 1 WHERE id = ${item.id}`);
      try {
        const result = await reconcile();
        const d = expectDrift(result.checks, 'stock', `item ${item.id}`, 'onHand');
        expect(d).toMatchObject({ expected: item.onHand.toFixed(3), actual: item.onHand.plus(1).toFixed(3), difference: '1.000' });
        expectDrift(result.checks, 'stock', 'product ', 'currentStock');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE InventoryItem SET onHand = onHand - 1 WHERE id = ${item.id}`);
      }
    });

    it('an edited account balance', async () => {
      await run.system(() => prisma.$executeRaw`UPDATE LedgerAccountBalance SET balance = balance + 0.01 WHERE shopId = ${shop.shopId} AND account = 'CASH'`);
      try {
        const result = await reconcile();
        expectDrift(result.checks, 'ledger', 'CASH', 'balance = Σ transactions');
        expectDrift(result.checks, 'ledger', 'CASH', 'last balanceAfter = balance');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE LedgerAccountBalance SET balance = balance - 0.01 WHERE shopId = ${shop.shopId} AND account = 'CASH'`);
      }
    });

    it('a posting without a document or entries', async () => {
      const sourceId = `orphan-${randomUUID()}`;
      const orphan = await run.system(() => prisma.ledgerPosting.create({ data: { shopId: shop.shopId, sourceType: 'SALE', sourceId, description: 'orphan on purpose' } }));
      try {
        const result = await reconcile();
        expectDrift(result.checks, 'postings', `SALE:${sourceId}`, 'posting rows');
        expectDrift(result.checks, 'postings', `SALE:${sourceId}`, 'source document');
      } finally {
        await run.system(() => prisma.ledgerPosting.delete({ where: { id: orphan.id } }));
      }
    });

    it('an edited repayment', async () => {
      const repayment = await run.system(() => prisma.udharTransaction.findFirstOrThrow({ where: { shopId: shop.shopId, type: 'PAYMENT', tender: 'UPI' } }));
      await run.system(() => prisma.$executeRaw`UPDATE UdharTransaction SET amount = amount + 1 WHERE id = ${repayment.id}`);
      try {
        const result = await reconcile();
        expectDrift(result.checks, 'documents', repayment.id, 'balance before − amount = balance after');
        expectDrift(result.checks, 'postings', repayment.id, 'DEBIT BANK');
        expectDrift(result.checks, 'tenders', 'ACCOUNTS_RECEIVABLE');
      } finally {
        await run.system(() => prisma.$executeRaw`UPDATE UdharTransaction SET amount = amount - 1 WHERE id = ${repayment.id}`);
      }
    });

    it('is clean again once every row is restored, and the history keeps the drift runs', async () => {
      const result = await reconcile();
      expect(result).toMatchObject({ status: 'CLEAN', driftCount: 0 });
      const drifted = await run.system(() => prisma.reconciliationRun.groupBy({ by: ['trigger'], where: { shopId: shop.shopId, status: 'DRIFT' }, _count: { _all: true } }));
      expect(Object.fromEntries(drifted.map((d) => [d.trigger, d._count._all]))).toEqual({ MANUAL: 7, CLI: 1 });
    });
  });

  it('reconciles each shop on its own documents', async () => {
    const other = await createShop(app, 'reconC', { creditLimit: 1000 });
    const soap = await createProduct(app, other, { key: 'soapC', sellingPrice: 50, costPrice: 30, gstRate: 'FIVE' });
    await receiveStock(app, other, soap, 5);
    await run.as(other.shopId, other.ownerId, Role.OWNER, () =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: soap, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 105 }] }, actorFor(other, other.ownerId, Role.OWNER)),
    );
    const result = await run.as(other.shopId, other.ownerId, Role.OWNER, () => recon.runForShop(other.shopId, { trigger: ReconciliationTrigger.MANUAL }));
    expect(result).toMatchObject({ status: 'CLEAN', driftCount: 0 });
    expect(result.summary).toMatchObject({ sales: { count: 1, total: '105.00' }, returns: { count: 0 }, shiftsChecked: 0, itemsChecked: 1, tenders: { CASH: '105.00', BANK: '0.00', UDHAR: '0.00' } });
  });
});

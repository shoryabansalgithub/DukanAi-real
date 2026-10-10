/**
 * Financial-year rollover and numbering continuity (roadmap 9.6) against the
 * real database. The application clock (`Clock`) is replaced with a settable
 * one, so the suite bills on 31 March 23:59 and 1 April 00:01 shop time
 * (Asia/Kolkata) and proves: the FY tag flips, the invoice and return
 * sequences restart at 1 for the new year, the old year's numbers stay as
 * they were and are never reused, the same-day cancellation window follows
 * the business day, the dashboard's business day and the invoice list's
 * day filter agree with the FY tags, and both days reconcile to the paisa.
 */
import { INestApplication } from '@nestjs/common';
import { ReconciliationTrigger, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceQueryService } from '../../src/billing/services/invoice-query.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { Clock } from '../../src/common/time/clock';
import { financialYearLabel } from '../../src/common/time/business-day';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';

/** A clock the suite moves by hand; everything billed reads it. */
class TestClock extends Clock {
  current = new Date();
  override now(): Date {
    return new Date(this.current.getTime());
  }
  set(iso: string): Date {
    this.current = new Date(iso);
    return this.current;
  }
}

describe('financial-year rollover (roadmap 9.6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let queries: InvoiceQueryService;
  let shifts: ShiftsService;
  let dashboard: DashboardService;
  let recon: ReconciliationService;
  let run: ReturnType<typeof tenantRunner>;
  let shop: TestShop;
  let tea: string;
  const clock = new TestClock();
  const sales: Record<string, { id: string; invoiceNumber: string; financialYear: string; createdAt: Date; lineId: string; total: number }> = {};

  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);
  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const asOwner = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.ownerId, Role.OWNER, fn);
  const sell = async (key: string, quantity: number) => {
    const result = await asCashier(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: tea, quantity }], payments: [{ tender: TenderType.CASH, amount: 118 * quantity }] }, cashier()),
    );
    const invoice = result.invoice;
    sales[key] = { id: invoice.id, invoiceNumber: invoice.invoiceNumber, financialYear: invoice.financialYear, createdAt: invoice.createdAt, lineId: invoice.items[0].id, total: num(invoice.totalAmount) };
    return sales[key];
  };
  const returnOf = (key: string) => asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: sales[key].id, items: [{ invoiceItemId: sales[key].lineId, quantity: 1 }], refund: { tender: TenderType.CASH } }, cashier()));
  const sequence = async (prefix: string) => {
    const row = await run.system(() => prisma.numberSequence.findFirst({ where: { shopId: shop.shopId, prefix } }));
    return row ? Number(row.lastNumber) : null;
  };

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(Clock).useValue(clock));
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    queries = app.get(InvoiceQueryService);
    shifts = app.get(ShiftsService);
    dashboard = app.get(DashboardService);
    recon = app.get(ReconciliationService);
    run = tenantRunner(app);
    shop = await createShop(app, 'fy');
    tea = await createProduct(app, shop, { key: 'fytea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
    await receiveStock(app, shop, tea, 100);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the shift opened on 31 March carries the clock, not the wall clock', async () => {
    const openedAt = clock.set('2027-03-31T23:50:00+05:30');
    const shift = await asCashier(() => shifts.open({ openingCash: 500 }, cashier()));
    expect(shift.openedAt.getTime()).toBe(openedAt.getTime());
  });

  it('31 March 23:59: numbers in FY 2026-27, invoice and return sequences at 1 and 2', async () => {
    const at = clock.set('2027-03-31T23:59:00+05:30');
    expect(financialYearLabel(at, TZ)).toBe('2026-27');
    const one = await sell('marchOne', 1);
    const two = await sell('marchTwo', 1);
    const three = await sell('marchThree', 2);
    expect([one.invoiceNumber, two.invoiceNumber, three.invoiceNumber]).toEqual(['INV-2026-27-000001', 'INV-2026-27-000002', 'INV-2026-27-000003']);
    expect([one.financialYear, two.financialYear, three.financialYear]).toEqual(['2026-27', '2026-27', '2026-27']);
    expect(one.createdAt.getTime()).toBe(at.getTime());

    const ret = await returnOf('marchOne');
    expect(ret.invoice.invoiceNumber).toBe('RET-2026-27-000001');
    expect(ret.invoice.financialYear).toBe('2026-27');
    expect(ret.invoice.createdAt.getTime()).toBe(at.getTime());
    expect(await sequence('INV-2026-27-')).toBe(3);
    expect(await sequence('RET-2026-27-')).toBe(1);
  });

  it('1 April 00:01: the FY tag flips, both sequences restart at 1, the old year keeps its last number', async () => {
    const at = clock.set('2027-04-01T00:01:00+05:30');
    expect(financialYearLabel(at, TZ)).toBe('2027-28');
    const one = await sell('aprilOne', 1);
    const two = await sell('aprilTwo', 1);
    expect([one.invoiceNumber, two.invoiceNumber]).toEqual(['INV-2027-28-000001', 'INV-2027-28-000002']);
    expect([one.financialYear, two.financialYear]).toEqual(['2027-28', '2027-28']);
    expect(one.createdAt.getTime()).toBe(at.getTime());

    // A return made in the new year of a sale from the old year numbers in the new year.
    const ret = await returnOf('marchTwo');
    expect(ret.invoice.invoiceNumber).toBe('RET-2027-28-000001');
    expect(ret.invoice.financialYear).toBe('2027-28');
    expect(ret.invoice.originalId).toBe(sales.marchTwo.id);

    // The old year's sequences are untouched and its numbers exist exactly once.
    expect(await sequence('INV-2026-27-')).toBe(3);
    expect(await sequence('RET-2026-27-')).toBe(1);
    expect(await sequence('INV-2027-28-')).toBe(2);
    expect(await sequence('RET-2027-28-')).toBe(1);
    const numbers = await run.system(() => prisma.invoice.findMany({ where: { shopId: shop.shopId }, select: { invoiceNumber: true, financialYear: true }, orderBy: { invoiceNumber: 'asc' } }));
    expect(numbers.map((n) => n.invoiceNumber)).toEqual([
      'INV-2026-27-000001',
      'INV-2026-27-000002',
      'INV-2026-27-000003',
      'INV-2027-28-000001',
      'INV-2027-28-000002',
      'RET-2026-27-000001',
      'RET-2027-28-000001',
    ]);
    // Every number carries the FY it was issued in.
    for (const n of numbers) expect(n.invoiceNumber).toContain(`-${n.financialYear}-`);
    // The unique key is (shop, FY, number): the new year's 000001 does not collide with the old year's.
    expect(numbers.filter((n) => n.invoiceNumber.endsWith('-000001'))).toHaveLength(4);
  });

  it('the same-day cancellation window follows the business day, not the wall clock', async () => {
    // 31 March's unreturned sale cannot be cancelled on 1 April; 1 April's can.
    await expect(asCashier(() => reversal.cancelInvoice(sales.marchThree.id, { reason: 'late' }, cashier()))).rejects.toMatchObject({ response: { code: 'INVOICE_NOT_CANCELLABLE' } });
    const cancelled = await asCashier(() => reversal.cancelInvoice(sales.aprilTwo.id, { reason: 'wrong bill' }, cashier()));
    expect(cancelled.invoice.status).toBe('CANCELLED');
    expect(cancelled.invoice.cancelledAt!.getTime()).toBe(clock.now().getTime());
    expect(cancelled.invoice.invoiceNumber).toBe('INV-2027-28-000002');
  });

  it("the dashboard's business day and the invoice list's day filter agree with the FY tags", async () => {
    const summary = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    expect(summary.businessDate).toBe('2027-04-01');
    expect(summary.timezone).toBe(TZ);
    // 1 April: one completed sale (the other was cancelled) minus the return made that day.
    expect(summary.todayOrders).toBe(1);
    expect(summary.todayReturnCount).toBe(1);
    expect(summary.todayGrossSales).toBe(118);
    expect(summary.todayReturns).toBe(118);
    expect(summary.todaySales).toBe(0);

    const april = await asOwner(() => queries.list({ from: '2027-04-01', to: '2027-04-01' }, actorFor(shop, shop.ownerId, Role.OWNER)));
    expect(april.total).toBe(3);
    expect(april.items.map((i) => i.invoiceNumber).sort()).toEqual(['INV-2027-28-000001', 'INV-2027-28-000002', 'RET-2027-28-000001']);
    const march = await asOwner(() => queries.list({ from: '2027-03-31', to: '2027-03-31' }, actorFor(shop, shop.ownerId, Role.OWNER)));
    expect(march.total).toBe(4);
    expect(march.items.map((i) => i.invoiceNumber).sort()).toEqual(['INV-2026-27-000001', 'INV-2026-27-000002', 'INV-2026-27-000003', 'RET-2026-27-000001']);
    const byDay = await run.system(() => prisma.invoice.findMany({ where: { shopId: shop.shopId }, select: { financialYear: true, createdAt: true } }));
    for (const row of byDay) expect(financialYearLabel(row.createdAt, TZ)).toBe(row.financialYear);
  });

  it('both days reconcile to the paisa across the rollover', async () => {
    const march = await asOwner(() => recon.runForShop(shop.shopId, { trigger: ReconciliationTrigger.MANUAL, date: '2027-03-31' }));
    expect(march).toMatchObject({ status: 'CLEAN', driftCount: 0, businessDate: '2027-03-31' });
    expect(march.summary).toMatchObject({ sales: { count: 3, total: '472.00' }, returns: { count: 1, total: '118.00' }, cancellations: { count: 0 }, shiftsChecked: 1 });
    const april = await asOwner(() => recon.runForShop(shop.shopId, { trigger: ReconciliationTrigger.MANUAL, date: '2027-04-01' }));
    expect(april).toMatchObject({ status: 'CLEAN', driftCount: 0, businessDate: '2027-04-01' });
    expect(april.summary).toMatchObject({ sales: { count: 1, total: '118.00' }, returns: { count: 1, total: '118.00' }, cancellations: { count: 1, total: '118.00' }, shiftsChecked: 1 });
    // The one shift spans both days and is rebuilt from its documents on each.
    const shift = await asCashier(() => shifts.current(cashier()));
    // opening + March sales (118 + 118 + 236) − March return + April sales (118 + 118) − April return − cancellation
    expect(num(shift!.expectedCash)).toBe(500 + 472 - 118 + 236 - 118 - 118);
  });
});

/**
 * Release audit, dashboard and report figures over the real stack:
 *
 *  - #10: gross profit subtracts only the cost of goods the ledger booked
 *    (a SERVICE line moves no stock and books no COST_OF_GOODS);
 *  - L10: outstanding udhar adds what customers owe, advances are their own
 *    figure (one customer's advance used to hide another's due);
 *  - L6: the Reports page's Net Profit is gross profit minus the period's
 *    expenses;
 *  - L11: invoices.csv lists cancelled documents with their status and both
 *    CSVs carry cess; the GST summary keeps excluding cancelled documents;
 *  - parseBusinessDate: a day the calendar does not have is 400 with a code on
 *    every route that takes a date.
 */
import { INestApplication } from '@nestjs/common';
import { LedgerAccount, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AnalyticsPageService } from '../../src/analytics-domain/services/analytics-page.service';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { httpAs, ownerOf } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);

/** Rows of a CSV whose cells carry no comma (the fixtures' names do not). */
const parseCsv = (text: string) => {
  const [header, ...rows] = text.trim().split('\r\n').map((line) => line.split(','));
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
};

describe('dashboard and report figures (release audit #10, L6, L10, L11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let customers: CustomersService;
  let dashboard: DashboardService;
  let analytics: AnalyticsPageService;
  let run: ReturnType<typeof tenantRunner>;
  let shop: TestShop;
  let owner$: Awaited<ReturnType<typeof httpAs>>;
  const products: Record<string, string> = {};
  const invoices: Record<string, { id: string; invoiceNumber: string }> = {};

  const owner = () => actorFor(shop, shop.ownerId, Role.OWNER);
  const asOwner = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.ownerId, Role.OWNER, fn);
  const sell = async (key: string, dto: Record<string, unknown>) => {
    const result = await asOwner(() => billing.createInvoice({ idempotencyKey: randomUUID(), ...dto } as never, owner()));
    invoices[key] = { id: result.invoice.id, invoiceNumber: result.invoice.invoiceNumber };
    return result;
  };
  const ledgerBalance = async (account: LedgerAccount) =>
    num((await run.system(() => prisma.ledgerAccountBalance.findUnique({ where: { shopId_account: { shopId: shop.shopId, account } } })))?.balance);

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    customers = app.get(CustomersService);
    dashboard = app.get(DashboardService);
    analytics = app.get(AnalyticsPageService);
    run = tenantRunner(app);
    shop = await createShop(app, 'figs', { creditLimit: 10_000 });
    owner$ = await httpAs(app, shop, ownerOf(shop));
    products.tea = await createProduct(app, shop, { key: 'tea', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
    products.svc = await createProduct(app, shop, { key: 'svc', sellingPrice: 200, costPrice: 60, gstRate: 'EIGHTEEN', type: 'SERVICE' });
    products.pan = await createProduct(app, shop, { key: 'pan', sellingPrice: 100, costPrice: 50, gstRate: 'TWENTYEIGHT', cessRate: 12 });
    await receiveStock(app, shop, products.tea, 20);
    await receiveStock(app, shop, products.pan, 20);
    await asOwner(() => app.get(ShiftsService).open({ openingCash: 500 }, owner()));

    await sell('tea', { items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] });
    await sell('svc', { items: [{ productId: products.svc, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] });
    await sell('pan', { items: [{ productId: products.pan, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 140 }] });
    await sell('credit', { customerId: shop.customerId, items: [{ productId: products.tea, quantity: 2 }], payments: [], udharAmount: 236 });
    await sell('cancelled', { items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] });
    await asOwner(() => reversal.cancelInvoice(invoices.cancelled.id, { reason: 'wrong bill' } as never, owner()));

    // A second customer pays ahead: a balance of -100.
    const advance = await run.system(() =>
      prisma.customer.create({ data: { shopId: shop.shopId, name: 'Advance', phone: `7${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '2')}`, creditLimit: 0 } }),
    );
    await asOwner(() => customers.recordPayment(advance.id, { idempotencyKey: randomUUID(), amount: 100, tender: TenderType.UPI, allowAdvance: true } as never, owner()));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gross profit subtracts only the cost of goods the ledger booked (no cost for a service line)', async () => {
    const s = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    // Taxable value of the completed sales: tea 100 + service 200 + pan 100 + credit tea 200.
    const taxable = 100 + 200 + 100 + 200;
    const cogs = await ledgerBalance(LedgerAccount.COST_OF_GOODS);
    expect(cogs).toBe(60 + 50 + 120); // the service line moved no stock and booked no cost
    expect(s.todayProfit).toBe(taxable - cogs);
    const top = await asOwner(() => dashboard.getTopProducts(shop.shopId, 10));
    expect(top.find((p) => p.productId === products.svc)).toMatchObject({ netRevenue: 200, cogs: 0, grossProfit: 200 });
    expect(top.find((p) => p.productId === products.tea)).toMatchObject({ netRevenue: 300, cogs: 180, grossProfit: 120 });
  });

  it('outstanding udhar is what customers owe; advances are a figure of their own', async () => {
    const s = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    expect({ outstandingUdhar: s.outstandingUdhar, customerAdvances: s.customerAdvances }).toEqual({ outstandingUdhar: 236, customerAdvances: 100 });
    const page = await asOwner(() => analytics.getAnalytics(shop.shopId, 'today'));
    expect(page.kpis).toMatchObject({ udharOutstanding: 236, customerAdvances: 100 });
  });

  it("Net Profit is gross profit minus the period's expenses", async () => {
    const lastMonth = new Date(Date.now() - 40 * 86_400_000).toISOString();
    expect((await owner$.post('/api/expenses').send({ description: 'Rent', category: 'Rent', amount: 150 })).status).toBe(201);
    expect((await owner$.post('/api/expenses').send({ description: 'Bill', category: 'Utilities', amount: 50, isPaid: false })).status).toBe(201);
    expect((await owner$.post('/api/expenses').send({ description: 'Old', category: 'Rent', amount: 999, expenseDate: lastMonth })).status).toBe(201);
    const removed = await owner$.post('/api/expenses').send({ description: 'Removed', category: 'Other', amount: 30 });
    expect((await owner$.delete(`/api/expenses/${removed.body.id}`)).status).toBe(200);

    const s = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    const today = await asOwner(() => analytics.getAnalytics(shop.shopId, 'today'));
    expect(today.kpis).toMatchObject({ grossProfit: s.todayProfit, expenses: 200, netProfit: s.todayProfit! - 200 });
    const month = await asOwner(() => analytics.getAnalytics(shop.shopId, 'month'));
    expect(month.kpis).toMatchObject({ expenses: 200, netProfit: month.kpis.grossProfit - 200 });
    const year = await asOwner(() => analytics.getAnalytics(shop.shopId, 'year'));
    expect(year.kpis).toMatchObject({ expenses: 1199, netProfit: year.kpis.grossProfit - 1199 });
  });

  it('invoices.csv lists the cancelled sale with its status, and both CSVs carry cess', async () => {
    const res = await owner$.get('/api/dashboard/export/invoices.csv');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const byNumber = new Map(rows.map((r) => [r.invoiceNumber, r]));
    expect(rows).toHaveLength(5);
    expect(byNumber.get(invoices.cancelled.invoiceNumber)).toMatchObject({ status: 'CANCELLED', type: 'SALE', totalAmount: '118' });
    expect(byNumber.get(invoices.cancelled.invoiceNumber)!.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byNumber.get(invoices.tea.invoiceNumber)).toMatchObject({ status: 'COMPLETED', cancelledAt: '', cessAmount: '0.00' });
    expect(byNumber.get(invoices.pan.invoiceNumber)).toMatchObject({ cessAmount: '12.00', taxAmount: '40', totalAmount: '140' });
    // The COMPLETED rows still add up to the dashboard's net sales.
    const s = await asOwner(() => dashboard.getSummary(shop.shopId, shop.ownerId));
    const completed = rows.filter((r) => r.status === 'COMPLETED').reduce((acc, r) => acc + (r.type === 'SALE' ? 1 : -1) * Number(r.totalAmount), 0);
    expect(completed).toBeCloseTo(s.todaySales!, 2);

    const items = parseCsv((await owner$.get('/api/dashboard/export/invoice-items.csv')).text);
    expect(items.find((i) => i.invoiceNumber === invoices.pan.invoiceNumber)).toMatchObject({ cessAmount: '12', totalAmount: '140' });
    expect(items.some((i) => i.invoiceNumber === invoices.cancelled.invoiceNumber)).toBe(false);

    // The GST summary keeps excluding the cancelled document.
    const gst = parseCsv((await owner$.get('/api/dashboard/export/gst-summary.csv')).text);
    expect(gst.find((r) => r.gstRate === '18')).toMatchObject({ invoiceCount: '3', taxableAmount: '500.00' });
    expect(gst.find((r) => r.gstRate === '28')).toMatchObject({ cess: '12.00' });
  });

  it('a day the calendar does not have is 400 with a code on every route that takes a date', async () => {
    const csv = await owner$.get('/api/dashboard/export/invoices.csv?from=2026-02-30&to=2026-03-01');
    expect([csv.status, csv.body.code]).toEqual([400, 'INVALID_DATE']);
    const list = await owner$.get('/api/billing/invoices?from=2026-02-30');
    expect([list.status, list.body.code]).toEqual([400, 'INVALID_DATE']);
    const runIt = await owner$.post('/api/reconciliation/run').send({ date: '2026-02-30' });
    expect([runIt.status, runIt.body.code]).toEqual([400, 'RECONCILIATION_INVALID_DATE']);
    // A real day still works.
    expect((await owner$.get('/api/billing/invoices?from=2026-02-28&to=2026-02-28')).status).toBe(200);
    expect((await owner$.post('/api/reconciliation/run').send({ date: '2026-02-28' })).status).toBe(201);
  });
});

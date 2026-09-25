/**
 * EXEC-005 dashboard certification: every dashboard figure is reconciled
 * against independent SQL over committed rows, across sales, discounts, tax,
 * cancellations, returns, credit, business-day boundaries, stock alerts,
 * insights, partial failures and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Prisma, Role, TenderType } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { DashboardInsightsService } from '../../src/analytics-domain/services/dashboard-insights.service';
import { AnalyticsPageService } from '../../src/analytics-domain/services/analytics-page.service';
import { startOfBusinessDay } from '../../src/common/time/business-day';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';
const DAY_MS = 24 * 3600 * 1000;

describe('Dashboard (EXEC-005)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let shifts: ShiftsService;
  let dashboard: DashboardService;
  let insights: DashboardInsightsService;
  let trends: AnalyticsPageService;
  let jwt: JwtService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let B: TestShop;
  let C: TestShop;

  const owner = (s: TestShop) => actorFor(s, s.ownerId, Role.OWNER);
  const as = <T>(s: TestShop, fn: () => Promise<T>) => run.as(s.shopId, s.ownerId, Role.OWNER, fn);
  const token = (s: TestShop) =>
    jwt.sign({ sub: s.ownerId, email: `owner-${s.suffix}@test.local`, role: 'OWNER', shopId: s.shopId, tokenVersion: 0 });
  const http = (s: TestShop | null, path: string) => {
    const req = request(app.getHttpServer()).get(`/api/dashboard/${path}`);
    return s ? req.set('Authorization', `Bearer ${token(s)}`) : req;
  };
  const sell = (s: TestShop, items: Array<Record<string, unknown>>, amount: number, extra: Record<string, unknown> = {}) =>
    as(s, () =>
      billing.createInvoice(
        { idempotencyKey: randomUUID(), items: items as never, payments: [{ tender: TenderType.CASH, amount }], ...extra },
        owner(s),
      ),
    );
  const moveInvoice = (id: string, createdAt: Date) =>
    run.system(() => prisma.invoice.update({ where: { id }, data: { createdAt } }));

  /** Independent truth: raw SQL over committed invoices of one business day. */
  const truthForDay = async (shopId: string, dayStart: Date) => {
    const rows = await run.system(() =>
      prisma.$queryRaw<Array<{ gross: unknown; returns: unknown; orders: unknown }>>`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'SALE' THEN totalAmount ELSE 0 END), 0) AS gross,
          COALESCE(SUM(CASE WHEN type = 'SALES_RETURN' THEN totalAmount ELSE 0 END), 0) AS returns,
          COALESCE(SUM(CASE WHEN type = 'SALE' THEN 1 ELSE 0 END), 0) AS orders
        FROM Invoice
        WHERE shopId = ${shopId} AND status = 'COMPLETED' AND isDeleted = false
          AND createdAt >= ${dayStart} AND createdAt < ${new Date(dayStart.getTime() + DAY_MS)}`,
    );
    const gross = num(rows[0].gross as Prisma.Decimal);
    const returns = num(rows[0].returns as Prisma.Decimal);
    return { gross, returns, net: Number((gross - returns).toFixed(2)), orders: Number(rows[0].orders) };
  };

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    shifts = app.get(ShiftsService);
    dashboard = app.get(DashboardService);
    insights = app.get(DashboardInsightsService);
    trends = app.get(AnalyticsPageService);
    jwt = app.get(JwtService);
    run = tenantRunner(app);
    A = await createShop(app, 'dshA', { creditLimit: 100000 });
    B = await createShop(app, 'dshB', { creditLimit: 100000 });
    C = await createShop(app, 'dshC', { creditLimit: 100000 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('empty shop: every figure is zero or empty, never null or NaN', async () => {
    const s = await as(A, () => dashboard.getSummary(A.shopId, A.ownerId));
    const k = await as(A, () => dashboard.getKpis(A.shopId));
    const t = await as(A, () => trends.getTrendSeries(A.shopId, 7));
    const i = await as(A, () => insights.getInsights(A.shopId));

    expect(s.failedSections).toEqual([]);
    for (const value of [s.todaySales, s.todayGrossSales, s.todayReturns, s.todayProfit, s.totalRevenue, s.inventoryValue, s.lowStockCount, s.outOfStockCount]) {
      expect(value).toBe(0);
    }
    expect(s.recentInvoices).toEqual([]);
    expect(s.paymentModes).toEqual([]);
    expect(s.lowStockItems).toEqual([]);
    expect(k).toMatchObject({ grossRevenue: 0, netRevenue: 0, totalRefunds: 0, orders: 0, avgOrderValue: 0 });
    expect(t).toHaveLength(7);
    expect(t.every((p) => p.sales === 0)).toBe(true);
    expect(i.failedSections).toEqual([]);
    expect(i.forecast).toMatchObject({ basisDays: 0, forecastNetRevenue: 0, todayNetSales: 0, progressPct: null });
    expect(i.restock?.items).toEqual([]);
    expect(i.topProduct).toBeNull();
  });

  it('reconciles today, revenue, KPIs, chart, profit, payment modes and recent invoices with SQL', async () => {
    const tea = await createProduct(app, A, { key: 'TEA', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN', reorderPoint: 5 });
    const rice = await createProduct(app, A, { key: 'RICE', sellingPrice: 80, costPrice: 50, gstRate: 'FIVE', reorderPoint: 2 });
    await receiveStock(app, A, tea, 50);
    await receiveStock(app, A, rice, 30);
    await as(A, () => shifts.open({ openingCash: 0 }, owner(A)));

    // KPIs cached as zero by the empty-shop test: every commit below must drop that cache.
    const s1 = await sell(A, [{ productId: tea, quantity: 2 }], 236); // 18% GST
    expect((await as(A, () => dashboard.getKpis(A.shopId))).netRevenue).toBe(236);
    await sell(A, [{ productId: rice, quantity: 3 }], 252); // 5% GST
    await sell(A, [{ productId: tea, quantity: 1, discountPercent: 10 }], 106); // discounted line, rounded
    const toCancel = await sell(A, [{ productId: tea, quantity: 1 }], 118);
    await as(A, () => reversal.cancelInvoice(toCancel.invoice.id, { reason: 'dashboard cert' }, owner(A)));
    await as(A, () =>
      reversal.processReturn(
        { idempotencyKey: randomUUID(), invoiceId: s1.invoice.id, items: [{ invoiceItemId: s1.invoice.items[0].id, quantity: 1 }], refund: { tender: TenderType.CASH } },
        owner(A),
      ),
    );
    await sell(A, [{ productId: rice, quantity: 1 }], 0, { customerId: A.customerId, payments: [], udharAmount: 84 }); // credit, second customer

    const today = startOfBusinessDay(new Date(), TZ);
    const truth = await truthForDay(A.shopId, today);
    expect(truth).toEqual({ gross: 678, returns: 118, net: 560, orders: 4 });

    const s = await as(A, () => dashboard.getSummary(A.shopId, A.ownerId));
    expect(s.failedSections).toEqual([]);
    expect(s).toMatchObject({
      todaySales: truth.net,
      todayGrossSales: truth.gross,
      todayReturns: truth.returns,
      todayOrders: truth.orders,
      todayReturnCount: 1,
      totalRevenue: truth.net,
      totalOrders: truth.orders,
      outstandingUdhar: 84,
    });

    // KPIs agree immediately (no outbox relay run): the commit dropped the cache.
    const k = await as(A, () => dashboard.getKpis(A.shopId));
    expect(k).toMatchObject({ grossRevenue: truth.gross, totalRefunds: truth.returns, netRevenue: truth.net, orders: truth.orders });
    expect(k.avgOrderValue).toBeCloseTo(truth.net / truth.orders, 2);

    // Chart point for today equals today's net sales.
    const t7 = await as(A, () => trends.getTrendSeries(A.shopId, 7));
    expect(t7[t7.length - 1].sales).toBe(truth.net);
    expect((await as(A, () => trends.getTrendSeries(A.shopId, 1)))[0].sales).toBe(truth.net);

    // Gross profit = taxable value - cost of goods, returns subtracted.
    const profit = await run.system(() => prisma.$queryRaw<Array<{ p: unknown }>>`
      SELECT COALESCE(SUM((CASE WHEN i.type = 'SALE' THEN 1 ELSE -1 END) * (ii.taxableAmount - ii.costPrice * ii.quantity)), 0) AS p
      FROM InvoiceItem ii JOIN Invoice i ON i.id = ii.invoiceId
      WHERE i.shopId = ${A.shopId} AND i.status = 'COMPLETED' AND i.isDeleted = false AND ii.isDeleted = false AND i.createdAt >= ${today}`);
    expect(s.todayProfit).toBeCloseTo(num(profit[0].p as Prisma.Decimal), 2);

    // Payment modes are net of refunds and add up to net sales.
    const modes = Object.fromEntries(s.paymentModes.map((m) => [m.mode, m.amount]));
    expect(modes).toEqual({ CASH: 236 + 252 + 106 - 118, UDHAR: 84 });
    expect(s.paymentModes.reduce((a, m) => a + m.amount, 0)).toBeCloseTo(truth.net, 2);

    // Recent invoices: committed rows of any day, newest first, cancellations included with their status.
    const dbTop = await run.system(() =>
      prisma.invoice.findMany({
        where: { shopId: A.shopId, isDeleted: false, status: { in: ['COMPLETED', 'CANCELLED'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true },
      }),
    );
    expect(s.recentInvoices.map((r) => r.id)).toEqual(dbTop.map((r) => r.id));
    expect(s.recentInvoices.some((r) => r.status === 'CANCELLED' && r.id === toCancel.invoice.id)).toBe(true);
    expect(s.recentInvoices.some((r) => r.type === 'SALES_RETURN')).toBe(true);
  });

  it('business day: 23:59:59 yesterday excluded, 00:00:00 today included; month start bucketed on its own date', async () => {
    const p = await createProduct(app, B, { key: 'BND', sellingPrice: 100, costPrice: 10 });
    await receiveStock(app, B, p, 20);
    const today = startOfBusinessDay(new Date(), TZ);
    const a = await sell(B, [{ productId: p, quantity: 1 }], 118);
    const b = await sell(B, [{ productId: p, quantity: 2 }], 236);
    await moveInvoice(a.invoice.id, new Date(today.getTime() - 1000));
    await moveInvoice(b.invoice.id, new Date(today.getTime()));

    const s = await as(B, () => dashboard.getSummary(B.shopId, B.ownerId));
    expect(s).toMatchObject({ todaySales: 236, todayOrders: 1 });
    const t2 = await as(B, () => trends.getTrendSeries(B.shopId, 2));
    expect(t2.map((x) => x.sales)).toEqual([118, 236]);

    const month = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date());
    const c = await sell(B, [{ productId: p, quantity: 3 }], 354);
    await moveInvoice(c.invoice.id, new Date(`${month}-01T00:00:00+05:30`));
    const t31 = (await as(B, () => trends.getTrendSeries(B.shopId, 31))) as Array<{ businessDate: string; sales: number }>;
    expect(new Set(t31.map((x) => x.businessDate)).size).toBe(t31.length);
    const monthStart = t31.find((x) => x.businessDate === `${month}-01`);
    if (monthStart) {
      // Month start is inside the window (it always is except on the 31st-plus-one edge).
      expect(monthStart.sales).toBeGreaterThanOrEqual(354);
      const before = t31.filter((x) => x.businessDate < `${month}-01`);
      expect(before.reduce((acc, x) => acc + x.sales, 0)).not.toBe(354);
    }
  });

  it('stock alerts follow committed stock and ignore services, digital and inactive products', async () => {
    const s0 = await as(B, () => dashboard.getSummary(B.shopId, B.ownerId));
    const lp = await createProduct(app, B, { key: 'LOWP', sellingPrice: 100, costPrice: 10, reorderPoint: 5 });
    await receiveStock(app, B, lp, 7);
    await sell(B, [{ productId: lp, quantity: 3 }], 354); // 7 -> 4: low
    const s1 = await as(B, () => dashboard.getSummary(B.shopId, B.ownerId));
    await sell(B, [{ productId: lp, quantity: 4 }], 472); // 4 -> 0: out
    const s2 = await as(B, () => dashboard.getSummary(B.shopId, B.ownerId));

    expect(s1.lowStockCount).toBe(s0.lowStockCount! + 1);
    expect(s1.lowStockItems.find((i) => i.productId === lp)).toMatchObject({ currentStock: 4, reorderPoint: 5, status: 'LOW_STOCK' });
    expect(s2.lowStockCount).toBe(s0.lowStockCount);
    expect(s2.outOfStockCount).toBe(s0.outOfStockCount! + 1);
    expect(s2.lowStockItems[0]).toMatchObject({ productId: lp, status: 'OUT_OF_STOCK' });

    // The dashboard reads Product.currentStock, which equals the inventory authority.
    const inv = await run.system(() => prisma.inventoryItem.aggregate({ where: { shopId: B.shopId, productId: lp }, _sum: { onHand: true } }));
    expect(num(inv._sum.onHand)).toBe(0);

    await createProduct(app, B, { key: 'SVC', type: 'SERVICE', sellingPrice: 100, costPrice: 0 });
    await createProduct(app, B, { key: 'DIG', type: 'DIGITAL', sellingPrice: 100, costPrice: 0 });
    await createProduct(app, B, { key: 'INACT', sellingPrice: 100, costPrice: 1, isActive: false });
    const s3 = await as(B, () => dashboard.getSummary(B.shopId, B.ownerId));
    expect(s3.outOfStockCount).toBe(s2.outOfStockCount);
    expect(s3.lowStockCount).toBe(s2.lowStockCount);

    // Full list over HTTP: same counts, out of stock first.
    const res = await http(B, 'low-stock?limit=50');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lowStockCount: s3.lowStockCount, outOfStockCount: s3.outOfStockCount });
    expect(res.body.items).toHaveLength(s3.lowStockCount! + s3.outOfStockCount!);
    const statuses: string[] = res.body.items.map((i: { status: string }) => i.status);
    expect(statuses).toEqual([...statuses].sort((x, y) => (x === y ? 0 : x === 'OUT_OF_STOCK' ? -1 : 1)));
  });

  it('insights: forecast vs today, restock suggestions from sales velocity, top product', async () => {
    const fast = await createProduct(app, C, { key: 'FAST', sellingPrice: 100, costPrice: 40, reorderPoint: 1 });
    const gone = await createProduct(app, C, { key: 'GONE', sellingPrice: 50, costPrice: 30, reorderPoint: 3 });
    const svc = await createProduct(app, C, { key: 'CSVC', type: 'SERVICE', sellingPrice: 100, costPrice: 0 });
    await receiveStock(app, C, fast, 40);
    await receiveStock(app, C, gone, 5);

    const yesterdaySale = await sell(C, [{ productId: fast, quantity: 1 }], 118);
    await moveInvoice(yesterdaySale.invoice.id, new Date(startOfBusinessDay(new Date(), TZ).getTime() - 3600 * 1000));
    await sell(C, [{ productId: fast, quantity: 35 }], 4130); // 40 -> 4 on hand, 36 sold in the window
    await sell(C, [{ productId: gone, quantity: 5 }], 295); // 5 -> 0
    await sell(C, [{ productId: svc, quantity: 1 }], 118);

    const i = await as(C, () => insights.getInsights(C.shopId));
    expect(i.failedSections).toEqual([]);

    // Forecast: 7-day average of complete days (only yesterday had sales) vs today's net so far.
    const todayNet = (await as(C, () => dashboard.getSummary(C.shopId, C.ownerId))).todaySales!;
    expect(i.forecast).toMatchObject({ basisDays: 1, forecastNetRevenue: 118, confidence: 'LOW', todayNetSales: todayNet });
    expect(i.forecast!.progressPct).toBe(Math.round((todayNet / 118) * 100));

    const items = i.restock!.items;
    expect(items.map((x) => x.productId)).toEqual([gone, fast]); // out of stock first
    expect(items.some((x) => x.productId === svc)).toBe(false);
    expect(items[0]).toMatchObject({ urgency: 'OUT_OF_STOCK', currentStock: 0, suggestedQuantity: 6 }); // 3 + 14 * 5/30 = 5.33 -> 6
    // 36 units / 30 days = 1.2/day; 4 on hand = 3.3 days; refill to 1 + 14 * 1.2 = 17.8 -> order 14.
    expect(items[1]).toMatchObject({ urgency: 'LOW', currentStock: 4, avgDailyUnits: 1.2, daysOfCover: 3.3, suggestedQuantity: 14 });

    expect(i.topProduct).toMatchObject({ productId: fast });
  });

  it('a failing summary part is reported, not fatal; insights sections fail independently too', async () => {
    const spy = jest
      .spyOn(dashboard as unknown as { inventoryValue: () => Promise<unknown> }, 'inventoryValue')
      .mockRejectedValue(new Error('simulated inventory query failure'));
    const res = await http(A, 'summary');
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.failedSections).toEqual(['inventoryValue']);
    expect(res.body.inventoryValue).toBeNull();
    expect(res.body.todaySales).toBe(560);
    expect(res.body.recentInvoices.length).toBeGreaterThan(0);

    const spy2 = jest.spyOn(insights, 'restockSuggestions').mockRejectedValue(new Error('simulated restock failure'));
    const ins = await http(C, 'insights');
    spy2.mockRestore();
    expect(ins.status).toBe(200);
    expect(ins.body.failedSections).toEqual(['restock']);
    expect(ins.body.restock).toBeNull();
    expect(ins.body.forecast).not.toBeNull();
  });

  it('tenant isolation over HTTP: every dashboard route is scoped by the token, never by the request', async () => {
    const [sa, sb] = await Promise.all([http(A, 'summary'), http(B, 'summary')]);
    expect(sa.status).toBe(200);
    expect(sb.status).toBe(200);
    const aIds = new Set(sa.body.recentInvoices.map((r: { id: string }) => r.id));
    expect(sb.body.recentInvoices.filter((r: { id: string }) => aIds.has(r.id))).toEqual([]);

    const spoof = await request(app.getHttpServer())
      .get(`/api/dashboard/summary?shopId=${A.shopId}`)
      .set('Authorization', `Bearer ${token(B)}`)
      .set('x-shop-id', A.shopId);
    expect(spoof.status).toBe(200);
    expect(spoof.body.todaySales).toBe(sb.body.todaySales);
    expect(spoof.body.recentInvoices.map((r: { id: string }) => r.id)).toEqual(sb.body.recentInvoices.map((r: { id: string }) => r.id));

    for (const path of ['kpis', 'trends?days=7', 'low-stock', 'insights']) {
      const [ra, rb] = await Promise.all([http(A, path), http(B, path)]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(JSON.stringify(ra.body)).not.toEqual(JSON.stringify(rb.body));
    }
    const bLow = await http(B, 'low-stock');
    const aProducts = await run.system(() => prisma.product.findMany({ where: { shopId: A.shopId }, select: { id: true } }));
    const aSet = new Set(aProducts.map((p) => p.id));
    expect(bLow.body.items.some((i: { productId: string }) => aSet.has(i.productId))).toBe(false);

    for (const path of ['summary', 'kpis', 'trends', 'low-stock', 'insights']) {
      expect((await http(null, path)).status).toBe(401);
    }
  });

  it('rejects nothing on bad query parameters: defaults and caps apply', async () => {
    const junk = await http(A, 'trends?days=abc');
    const huge = await http(A, 'trends?days=100000');
    expect(junk.status).toBe(200);
    expect(junk.body).toHaveLength(30);
    expect(huge.status).toBe(200);
    expect(huge.body.length).toBeLessThanOrEqual(366);
    const low = await http(A, 'low-stock?limit=abc');
    const lowHuge = await http(A, 'low-stock?limit=100000');
    expect(low.status).toBe(200);
    expect(lowHuge.status).toBe(200);
  });
});

/**
 * Roadmap 4.9: the nightly analytics job computes ABC/XYZ classes from real
 * sales, writes one recommendation per (shop, product, business day, type),
 * keeps a user's DISMISSED status across re-runs, prunes old rows and runs
 * every shop under one cron lock.
 */
import { INestApplication } from '@nestjs/common';
import { AbcClass, Role, TenderType, XyzClass } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { AnalyticsJobScheduler } from '../../src/analytics-domain/services/analytics-job.scheduler';
import { REORDER_COVER_DAYS } from '../../src/analytics-domain/services/recommendation-engine.service';
import { CLASSIFICATION_WINDOW_DAYS } from '../../src/analytics-domain/engines/classification-engine';
import { trailingBusinessDays } from '../../src/analytics-domain/analytics-range';
import { kpiDateFor } from '../../src/analytics-domain/services/kpi.service';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';
const DAY_MS = 24 * 3600 * 1000;

describe('Nightly analytics (roadmap 4.9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let shifts: ShiftsService;
  let scheduler: AnalyticsJobScheduler;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let B: TestShop;
  const now = new Date();
  const today = kpiDateFor(now, TZ);
  const products: Record<string, string> = {};

  const owner = (s: TestShop) => actorFor(s, s.ownerId, Role.OWNER);
  const as = <T>(s: TestShop, fn: () => Promise<T>) => run.as(s.shopId, s.ownerId, Role.OWNER, fn);
  /** Sells `quantity` of a zero-GST product (total = price × quantity) and dates the invoice into classification week `week` (0 = oldest). */
  const sellInWeek = async (s: TestShop, productId: string, price: number, quantity: number, week: number) => {
    const { start } = trailingBusinessDays(CLASSIFICATION_WINDOW_DAYS, TZ, now);
    const sale = await as(s, () =>
      billing.createInvoice(
        { idempotencyKey: randomUUID(), items: [{ productId, quantity }] as never, payments: [{ tender: TenderType.CASH, amount: price * quantity }] },
        owner(s),
      ),
    );
    await run.system(() => prisma.invoice.update({ where: { id: sale.invoice.id }, data: { createdAt: new Date(start.getTime() + week * 7 * DAY_MS + 12 * 3600 * 1000) } }));
  };
  const classesOf = async (s: TestShop) => {
    const rows = await run.system(() => prisma.inventoryClassification.findMany({ where: { shopId: s.shopId } }));
    return Object.fromEntries(rows.map((r) => [Object.keys(products).find((k) => products[k] === r.productId) ?? r.productId, `${r.abcClass}/${r.xyzClass}`]));
  };
  const recommendationsOf = (s: TestShop) =>
    run.system(() => prisma.inventoryRecommendation.findMany({ where: { shopId: s.shopId }, orderBy: [{ productId: 'asc' }, { type: 'asc' }] }));

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    shifts = app.get(ShiftsService);
    scheduler = app.get(AnalyticsJobScheduler);
    run = tenantRunner(app);
    A = await createShop(app, 'nightA');
    B = await createShop(app, 'nightB');
    await as(A, () => shifts.open({ openingCash: 0 }, owner(A)));

    const zero = { gstRate: 'ZERO' as const, costPrice: 1 };
    products.HERO = await createProduct(app, A, { key: 'HERO', sellingPrice: 200, ...zero });
    products.MID = await createProduct(app, A, { key: 'MID', sellingPrice: 100, ...zero });
    products.VARY = await createProduct(app, A, { key: 'VARY', sellingPrice: 20, ...zero });
    products.TAIL = await createProduct(app, A, { key: 'TAIL', sellingPrice: 10, ...zero });
    products.IDLE = await createProduct(app, A, { key: 'IDLE', sellingPrice: 50, ...zero });
    products.BONLY = await createProduct(app, B, { key: 'BONLY', sellingPrice: 50, ...zero });
    await receiveStock(app, A, products.HERO, 13); // sells out: stockout risk -> REORDER
    await receiveStock(app, A, products.MID, 10);
    await receiveStock(app, A, products.VARY, 20);
    await receiveStock(app, A, products.TAIL, 5);
    await receiveStock(app, A, products.IDLE, 100); // never sells: dead stock -> LIQUIDATE
    await receiveStock(app, B, products.BONLY, 5);

    // HERO: 1 unit every week (2600 of 2970 revenue = 87.5 %): A, steady (X).
    for (let week = 0; week < 13; week++) await sellInWeek(A, products.HERO, 200, 1, week);
    // MID: 2 units in two weeks (200): starts at 87.5 % -> B; sporadic (Z).
    await sellInWeek(A, products.MID, 100, 2, 0);
    await sellInWeek(A, products.MID, 100, 2, 6);
    // VARY: 1 unit in 8 of 13 weeks (160): starts at 94.3 % -> B; intermittent (Y).
    for (const week of [0, 1, 3, 5, 7, 9, 11, 12]) await sellInWeek(A, products.VARY, 20, 1, week);
    // TAIL: one unit once (10): C, Z.
    await sellInWeek(A, products.TAIL, 10, 1, 4);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('classifies every live product from the last 13 weeks of net sales, per shop', async () => {
    const summary = await scheduler.runDailyAnalytics(now);
    expect(summary.failed).toBe(0);
    expect(summary.shops).toBeGreaterThanOrEqual(2);

    expect(await classesOf(A)).toEqual({
      HERO: `${AbcClass.A}/${XyzClass.X}`,
      MID: `${AbcClass.B}/${XyzClass.Z}`,
      VARY: `${AbcClass.B}/${XyzClass.Y}`,
      TAIL: `${AbcClass.C}/${XyzClass.Z}`,
      IDLE: `${AbcClass.UNCLASSIFIED}/${XyzClass.UNCLASSIFIED}`,
    });
    expect(await classesOf(B)).toEqual({ BONLY: `${AbcClass.UNCLASSIFIED}/${XyzClass.UNCLASSIFIED}` });
  });

  it('writes the KPI demand rate and derives recommendations keyed by (shop, product, day, type)', async () => {
    const hero = await run.system(() => prisma.inventoryKpi.findUniqueOrThrow({ where: { shopId_productId_date: { shopId: A.shopId, productId: products.HERO, date: today } } }));
    expect(num(hero.avgDailyUnits)).toBeGreaterThan(0);
    expect(num(hero.stockoutRiskScore)).toBe(90); // sold out

    const rows = await recommendationsOf(A);
    const keys = rows.map((r) => [r.productId, r.type]);
    expect(keys).toContainEqual([products.HERO, 'REORDER']); // sold out
    expect(keys).toContainEqual([products.IDLE, 'LIQUIDATE']); // never sold
    expect(keys).toContainEqual([products.MID, 'LIQUIDATE']); // last sale 7 weeks ago, 6 on hand
    expect(keys).not.toContainEqual([products.HERO, 'LIQUIDATE']);
    expect(keys).not.toContainEqual([products.IDLE, 'REORDER']);
    expect(new Set(keys.map(([, type]) => type))).toEqual(new Set(['REORDER', 'LIQUIDATE']));
    expect(new Set(keys.map((k) => k.join(':'))).size).toBe(keys.length); // one row per (product, type)
    expect(rows.every((r) => r.forDate.getTime() === today.getTime() && r.status === 'ACTIVE')).toBe(true);

    const reorder = rows.find((r) => r.productId === products.HERO && r.type === 'REORDER')!;
    expect(num(reorder.score)).toBe(90);
    expect(reorder.actionData).toMatchObject({
      suggestedQuantity: Math.max(1, Math.ceil(num(hero.avgDailyUnits) * REORDER_COVER_DAYS)),
      abcClass: AbcClass.A,
      xyzClass: XyzClass.X,
    });
    const liquidate = rows.find((r) => r.productId === products.IDLE && r.type === 'LIQUIDATE')!;
    expect(liquidate.actionData).toMatchObject({ suggestedDiscount: 20, abcClass: AbcClass.UNCLASSIFIED });
    expect(num(liquidate.score)).toBe(95);
    // Shop B: its only product never sold and holds stock, so it gets exactly one LIQUIDATE row and nothing of shop A's.
    expect((await recommendationsOf(B)).map((r) => [r.productId, r.type])).toEqual([[products.BONLY, 'LIQUIDATE']]);
  });

  it('a re-run of the same night upserts instead of appending and keeps a dismissed status', async () => {
    const before = await recommendationsOf(A);
    await run.system(() => prisma.inventoryRecommendation.update({ where: { id: before[0].id }, data: { status: 'DISMISSED' } }));
    // Stale rows: one past the retention window (pruned) and one inside it (kept).
    const seed = (daysAgo: number, type: 'DISCOUNT' | 'TRANSFER') =>
      run.system(() =>
        prisma.inventoryRecommendation.create({
          data: { shopId: A.shopId, productId: products.MID, forDate: new Date(today.getTime() - daysAgo * DAY_MS), type, score: 1, reason: 'seed' },
        }),
      );
    const old = await seed(120, 'DISCOUNT');
    const recent = await seed(30, 'TRANSFER');

    const summary = await scheduler.runDailyAnalytics(now);
    expect(summary.failed).toBe(0);

    const after = await recommendationsOf(A);
    expect(after.filter((r) => r.forDate.getTime() === today.getTime()).map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.find((r) => r.id === before[0].id)?.status).toBe('DISMISSED');
    expect(after.find((r) => r.id === old.id)).toBeUndefined();
    expect(after.find((r) => r.id === recent.id)).toBeDefined();
    expect(await run.system(() => prisma.inventoryClassification.count({ where: { shopId: A.shopId } }))).toBe(5);
  });

  it('a deleted product leaves the classification table on the next run', async () => {
    await run.system(() => prisma.product.update({ where: { id: products.TAIL }, data: { isDeleted: true, deletedAt: new Date() } }));
    await run.as(A.shopId, A.ownerId, Role.OWNER, () => scheduler.runForShop(A.shopId, now));
    expect(await classesOf(A)).not.toHaveProperty('TAIL');
    expect(await run.system(() => prisma.inventoryClassification.count({ where: { shopId: A.shopId } }))).toBe(4);
  });

  it('runs the night under the cluster cron lock', async () => {
    const summary = await scheduler.handleCron();
    expect(summary).not.toBeNull();
    expect(summary?.failed).toBe(0);
  });
});

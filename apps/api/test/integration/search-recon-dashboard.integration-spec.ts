/**
 * Roadmap 5.3 / 5.4 / 5.5 over the real stack: bounded search input with a
 * single synonym lookup and a rate-limited history insert; keyset-paged stock
 * reconciliation; cached all-time dashboard totals dropped by every sale.
 */
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import type { Cache } from 'cache-manager';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { RevenueEngine } from '../../src/analytics-domain/engines/revenue-engine';
import { InventoryReconService } from '../../src/inventory/inventory-recon.service';
import { InventoryFeatureConfig } from '../../src/config/domains/features/inventory-feature.config';
import { SearchFeatureConfig } from '../../src/config/domains/features/search-feature.config';
import { MAX_SEARCH_QUERY_LENGTH } from '../../src/product-search/search-term';
import { actorFor, bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';
import { httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

describe('Search limits, reconciliation paging, dashboard totals cache (roadmap 5.3-5.5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let cache: Cache;
  let A: TestShop;
  let owner: Awaited<ReturnType<typeof httpAs>>;

  beforeAll(async () => {
    const inventory = Object.assign(new InventoryFeatureConfig(), { reconBatchSize: 2, reconLookbackMs: 15 * 60 * 1000, reconLockTtlMs: 60_000 });
    const search = Object.assign(new SearchFeatureConfig(), { historyMaxPerMinute: 2, searchResultLimit: 50, fuzzyCandidateLimit: 100, analyticsLimit: 100 });
    app = await bootApp((b) => b.overrideProvider(InventoryFeatureConfig).useValue(inventory).overrideProvider(SearchFeatureConfig).useValue(search));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    cache = app.get<Cache>(CACHE_MANAGER);
    A = await createShop(app, 'srd');
    owner = await httpAs(app, A, ownerOf(A));
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('5.3 search', () => {
    it('a query is cut to the cap, the history row stores the cut value, and inserts stop at the per-minute budget', async () => {
      const product = await createProduct(app, A, { key: 'DETERGENT' });
      await receiveStock(app, A, product, 5);
      // The budget is per clock minute: do not start within the last seconds of one.
      const intoMinute = Date.now() % 60_000;
      if (intoMinute > 54_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 200));
      const long = `Detergent ${A.suffix} ${'padding '.repeat(60)}`.trim();
      const first = await owner.get(`/api/search?q=${encodeURIComponent(long)}`);
      expect(first.status).toBe(200);
      await new Promise((r) => setTimeout(r, 200)); // logging is fire-and-forget
      const rows = await run.system(() => prisma.searchHistory.findMany({ where: { shopId: A.shopId } }));
      expect(rows).toHaveLength(1);
      expect(rows[0].query.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_LENGTH);
      expect(long.startsWith(rows[0].query)).toBe(true);

      for (let i = 0; i < 4; i++) expect((await owner.get(`/api/search?q=tea${i}`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      // Budget of 2 per minute: the first search plus one more were recorded, the rest were served but not stored.
      expect(await run.system(() => prisma.searchHistory.count({ where: { shopId: A.shopId } }))).toBe(2);
      expect((await owner.get(`/api/search/suggestions?q=${encodeURIComponent('x'.repeat(400))}`)).status).toBe(200);
    });

    it('synonyms registered for the shop expand the query and find the product', async () => {
      const soap = await createProduct(app, A, { key: 'SOAPBAR' });
      await receiveStock(app, A, soap, 5);
      expect((await owner.post('/api/search/synonyms').send({ term: 'sabun', synonyms: 'soapbar, cleaning bar' })).status).toBe(201);
      const res = await owner.get('/api/search?q=Sabun%20SABUN%20sabun');
      expect(res.status).toBe(200);
      expect(res.body.map((p: { id: string }) => p.id)).toContain(soap);
    });
  });

  describe('5.4 reconciliation', () => {
    it('walks the window in keyset pages and repairs every drifted product once, skipping rows outside the window', async () => {
      const recon = app.get(InventoryReconService);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await createProduct(app, A, { key: `RECON${i}` });
        await receiveStock(app, A, id, 10);
        ids.push(id);
      }
      // Drift: cached currentStock disagrees with the ledger sum (10).
      await run.system(() => prisma.product.updateMany({ where: { id: { in: ids } }, data: { currentStock: 99 } }));
      // One product updated long before the lookback window: not visited.
      const stale = await createProduct(app, A, { key: 'RECONOLD' });
      await receiveStock(app, A, stale, 10);
      await run.system(() => prisma.$executeRaw`UPDATE Product SET currentStock = 99, updatedAt = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id = ${stale}`);

      const runStart = new Date();
      // One product updated after the run started: outside the closed window, left for the next run.
      await new Promise((r) => setTimeout(r, 20));
      const late = await createProduct(app, A, { key: 'RECONLATE' });
      await receiveStock(app, A, late, 10);
      await run.system(() => prisma.product.update({ where: { id: late }, data: { currentStock: 99 } }));

      const summary = await run.system(() => recon.runReconciliation(runStart));
      expect(summary).not.toBeNull();
      expect(summary!.batches).toBeGreaterThanOrEqual(3); // 5 drifted products (plus other suites' rows) in pages of 2
      expect(summary!.ledgerDrifts.fixed).toBeGreaterThanOrEqual(5);

      const repaired = await run.system(() => prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, currentStock: true } }));
      expect(repaired.every((p) => num(p.currentStock) === 10)).toBe(true);
      expect(num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: stale } }))).currentStock)).toBe(99);
      expect(num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: late } }))).currentStock)).toBe(99);

      // The next run (window includes the late update) repairs it.
      const again = await run.system(() => recon.runReconciliation(new Date()));
      expect(again!.ledgerDrifts.fixed).toBeGreaterThanOrEqual(1);
      expect(num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: late } }))).currentStock)).toBe(10);
    });
  });

  describe('5.5 dashboard all-time totals', () => {
    it('are cached under the analytics key family and dropped by a committed sale', async () => {
      const dashboard = app.get(DashboardService);
      const revenue = app.get(RevenueEngine);
      const billing = app.get(BillingService);
      const shifts = app.get(ShiftsService);
      const key = `shop:${A.shopId}:analytics:allTime`;
      const as = <T>(fn: () => Promise<T>) => run.as(A.shopId, A.ownerId, Role.OWNER, fn);

      await cache.del(key);
      const first = await as(() => dashboard.getSummary(A.shopId, A.ownerId));
      expect(first.failedSections).toEqual([]);
      const cached = await cache.get<{ netSales: string; orders: number }>(key);
      expect(cached).toMatchObject({ orders: first.totalOrders });

      const spy = jest.spyOn(revenue, 'totals');
      const second = await as(() => dashboard.getSummary(A.shopId, A.ownerId));
      expect(second.totalRevenue).toBe(first.totalRevenue);
      // Only the ranged "today" aggregate ran; the all-time one came from the cache.
      expect(spy.mock.calls.filter((c) => c.length === 1 || (c[1] === undefined && c[2] === undefined))).toHaveLength(0);
      spy.mockRestore();

      const product = await createProduct(app, A, { key: 'CACHESALE', sellingPrice: 100, gstRate: 'ZERO' });
      await receiveStock(app, A, product, 5);
      await as(() => shifts.open({ openingCash: 0 }, actorFor(A, A.ownerId, Role.OWNER)));
      await as(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: product, quantity: 1 }] as never, payments: [{ tender: TenderType.CASH, amount: 100 }] }, actorFor(A, A.ownerId, Role.OWNER)));
      expect(await cache.get(key)).toBeUndefined();
      const third = await as(() => dashboard.getSummary(A.shopId, A.ownerId));
      expect(third.totalOrders).toBe((first.totalOrders ?? 0) + 1);
      expect(third.totalRevenue).toBe(Number(((first.totalRevenue ?? 0) + 100).toFixed(2)));
    });
  });
});

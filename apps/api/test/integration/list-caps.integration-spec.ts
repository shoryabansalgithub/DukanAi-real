/**
 * Roadmap 5.6 / 5.7 over the real stack: every list answers a hard-capped
 * page (array body, page in headers, out-of-range values are 400), the
 * legacy `limit`/`offset` routes share the cap, the global guards still
 * protect every route after the duplicate `@UseGuards` were removed, and a
 * category move re-roots its whole subtree with one statement.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEFAULT_LIST_TAKE, MAX_LIST_TAKE, PAGE_HEADERS } from '../../src/common/pagination';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { cashierOf, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

describe('List caps, guard dedupe and subtree moves (roadmap 5.6, 5.7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let owner: Awaited<ReturnType<typeof httpAs>>;
  let cashier: Awaited<ReturnType<typeof httpAs>>;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'caps');
    owner = await httpAs(app, A, ownerOf(A));
    cashier = await httpAs(app, A, cashierOf(A));
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('5.6 every list is a capped page', () => {
    it('expenses: array body, page headers, skip/take honoured, out-of-range refused', async () => {
      for (let i = 0; i < 3; i++) {
        expect((await owner.post('/api/expenses').send({ description: `Rent ${i}`, category: 'Rent', amount: 100 + i })).status).toBe(201);
      }
      const all = await owner.get('/api/expenses');
      expect(all.status).toBe(200);
      expect(Array.isArray(all.body)).toBe(true);
      expect(all.body).toHaveLength(3);
      expect(all.headers[PAGE_HEADERS.total.toLowerCase()]).toBe('3');
      expect(all.headers[PAGE_HEADERS.skip.toLowerCase()]).toBe('0');
      expect(all.headers[PAGE_HEADERS.take.toLowerCase()]).toBe(String(DEFAULT_LIST_TAKE));

      const page = await owner.get('/api/expenses?skip=2&take=2');
      expect(page.status).toBe(200);
      expect(page.body).toHaveLength(1);
      expect(page.headers[PAGE_HEADERS.total.toLowerCase()]).toBe('3');
      expect(page.headers[PAGE_HEADERS.skip.toLowerCase()]).toBe('2');
      expect(page.headers[PAGE_HEADERS.take.toLowerCase()]).toBe('2');
      const first = await owner.get('/api/expenses?take=2');
      expect(first.body.map((e: { id: string }) => e.id)).toEqual(all.body.slice(0, 2).map((e: { id: string }) => e.id));

      expect((await owner.get(`/api/expenses?take=${MAX_LIST_TAKE + 1}`)).status).toBe(400);
      expect((await owner.get('/api/expenses?take=0')).status).toBe(400);
      expect((await owner.get('/api/expenses?take=all')).status).toBe(400);
      expect((await owner.get('/api/expenses?skip=-1')).status).toBe(400);
      expect((await owner.get(`/api/expenses?take=${MAX_LIST_TAKE}`)).status).toBe(200);
    });

    it('every formerly unbounded list answers a capped array and refuses a page above the cap', async () => {
      const product = await createProduct(app, A, { key: 'CAPS' });
      expect((await owner.post('/api/inventory-domain').send({ productId: product })).status).toBe(201);
      const routes = [
        '/api/suppliers',
        '/api/batches',
        '/api/categories',
        '/api/inventory-domain',
        '/api/inventory-domain/alerts',
        '/api/inventory/products',
        '/api/notifications',
        '/api/warehouse-domain/warehouses',
      ];
      for (const route of routes) {
        const res = await owner.get(route);
        expect([route, res.status]).toEqual([route, 200]);
        expect(Array.isArray(res.body)).toBe(true);
        expect(Number(res.headers[PAGE_HEADERS.take.toLowerCase()])).toBeLessThanOrEqual(MAX_LIST_TAKE);
        expect(res.headers[PAGE_HEADERS.total.toLowerCase()]).toMatch(/^\d+$/);
        expect([route, (await owner.get(`${route}?take=5000`)).status]).toEqual([route, 400]);
        expect([route, (await owner.get(`${route}?take=1`)).status]).toEqual([route, 200]);
      }
      // A list the web reads whole still arrives as a plain array (UI unchanged).
      const products = await owner.get('/api/inventory/products?take=1');
      expect(products.body).toHaveLength(1);
      expect(products.body[0]).toHaveProperty('name');
    });

    it('the lists outside the roadmap row are capped too: employees, webhooks, workflow tasks and definitions, media galleries, sessions, barcode history, shifts', async () => {
      const product = await createProduct(app, A, { key: 'CAPS2' });
      const routes = [
        '/api/users/employees',
        '/api/webhooks',
        '/api/procurement-workflows/tasks/pending',
        '/api/procurement-workflows/definitions',
        `/api/media/product/${product}`,
        '/api/auth/sessions',
        '/api/shifts',
      ];
      for (const route of routes) {
        const res = await owner.get(route);
        expect([route, res.status]).toEqual([route, 200]);
        expect([route, (await owner.get(`${route}?take=5000`)).status]).toEqual([route, 400]);
        expect([route, (await owner.get(`${route}?take=1`)).status]).toEqual([route, 200]);
      }
      // Array bodies with page headers for the ones on the shared layer; shifts keeps its own `{ items, total }` envelope.
      const employees = await owner.get('/api/users/employees?take=1');
      expect(Array.isArray(employees.body)).toBe(true);
      expect(employees.body).toHaveLength(1);
      expect(Number(employees.headers[PAGE_HEADERS.total.toLowerCase()])).toBeGreaterThanOrEqual(2);
      const shifts = await owner.get('/api/shifts?take=1');
      expect(shifts.body).toMatchObject({ take: 1, skip: 0 });
      expect(Array.isArray(shifts.body.items)).toBe(true);
      // A barcode nobody knows answers an empty page, not a 500.
      const history = await owner.get(`/api/product-identity/barcode/NOPE-${A.suffix}/history?take=1`);
      expect([200, 404]).toContain(history.status);
      if (history.status === 200) expect(history.body).toEqual([]);
    });

    it('a repeated or over-long q on the search and product lists is cut, never a 500', async () => {
      for (const route of ['/api/search', '/api/search/suggestions', '/api/products']) {
        expect([route, (await owner.get(`${route}?q=tea&q=coffee`)).status]).toEqual([route, 200]);
        expect([route, (await owner.get(`${route}?q=${encodeURIComponent('x'.repeat(5000))}`)).status]).toEqual([route, 200]);
      }
    });

    it('the procurement lists keep their limit/offset names under the same cap', async () => {
      for (const route of ['/api/purchases', '/api/grn', '/api/vendor-bills', '/api/purchase-returns', '/api/supplier-credit-notes', '/api/purchase-events/dead-letter']) {
        expect([route, (await owner.get(`${route}?limit=5000`)).status]).toEqual([route, 400]);
        expect([route, (await owner.get(`${route}?limit=-1`)).status]).toEqual([route, 400]);
        expect([route, (await owner.get(`${route}?offset=x`)).status]).toEqual([route, 400]);
        const ok = await owner.get(`${route}?limit=10&offset=0`);
        expect([route, ok.status]).toEqual([route, 200]);
        expect(Array.isArray(ok.body)).toBe(true);
      }
    });

    it('the location subtree requires its path and pages like the rest', async () => {
      const wh = await owner.post('/api/warehouse-domain/warehouses').send({ code: `CAP-${A.suffix}`, name: 'Caps', type: 'MAIN' });
      expect(wh.status).toBe(201);
      expect((await owner.get(`/api/warehouse-domain/warehouses/${wh.body.id}/locations/subtree`)).status).toBe(400);
      const subtree = await owner.get(`/api/warehouse-domain/warehouses/${wh.body.id}/locations/subtree?path=/&take=1`);
      expect(subtree.status).toBe(200);
      expect(Array.isArray(subtree.body)).toBe(true);
      expect(subtree.headers[PAGE_HEADERS.take.toLowerCase()]).toBe('1');
    });
  });

  describe('5.7 guards are global, once', () => {
    it('anonymous and under-privileged calls are still refused on routes that lost their local @UseGuards', async () => {
      const server = app.getHttpServer();
      expect((await request(server).get('/api/categories')).status).toBe(401);
      expect((await request(server).get('/api/purchases')).status).toBe(401);
      expect((await request(server).get('/api/warehouse-domain/warehouses')).status).toBe(401);
      expect((await cashier.post('/api/categories').send({ name: `No ${A.suffix}` })).status).toBe(403);
      expect((await cashier.post('/api/warehouse-domain/warehouses').send({ code: `X-${A.suffix}`, name: 'No', type: 'MAIN' })).status).toBe(403);
      expect((await cashier.get('/api/categories')).status).toBe(200);
    });
  });

  describe('5.7 category move', () => {
    it('re-roots every descendant (path and depth) in one statement, inside the move transaction', async () => {
      const mk = async (name: string, parentId?: string) => {
        const res = await owner.post('/api/categories').send({ name: `${name} ${A.suffix}`, ...(parentId ? { parentId } : {}) });
        expect(res.status).toBe(201);
        return res.body as { id: string; path: string; depth: number };
      };
      const root = await mk('Root');
      const mid = await mk('Mid', root.id);
      const leaf = await mk('Leaf', mid.id);
      const leaf2 = await mk('Leaf2', mid.id);
      const other = await mk('Other');
      const otherChild = await mk('OtherChild', other.id);
      expect(leaf.path).toBe(`/${root.id}/${mid.id}/`);
      expect(leaf.depth).toBe(2);

      const moved = await owner.patch(`/api/categories/${mid.id}`).send({ name: `Mid ${A.suffix}`, parentId: other.id });
      expect(moved.status).toBe(200);
      expect(moved.body.path).toBe(`/${other.id}/`);
      expect(moved.body.depth).toBe(1);

      const rows = await run.system(() => prisma.category.findMany({ where: { id: { in: [root.id, mid.id, leaf.id, leaf2.id, other.id, otherChild.id] } }, select: { id: true, path: true, depth: true } }));
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[leaf.id]).toMatchObject({ path: `/${other.id}/${mid.id}/`, depth: 2 });
      expect(byId[leaf2.id]).toMatchObject({ path: `/${other.id}/${mid.id}/`, depth: 2 });
      // Untouched: the old root, the new parent and its own child.
      expect(byId[root.id]).toMatchObject({ path: '/', depth: 0 });
      expect(byId[other.id]).toMatchObject({ path: '/', depth: 0 });
      expect(byId[otherChild.id]).toMatchObject({ path: `/${other.id}/`, depth: 1 });

      // Moving under its own descendant is refused.
      expect((await owner.patch(`/api/categories/${mid.id}`).send({ name: `Mid ${A.suffix}`, parentId: leaf.id })).status).toBe(400);

      // A move to the root (parentId null) re-roots the subtree the same way, with a real depth change.
      const toRoot = await owner.patch(`/api/categories/${mid.id}`).send({ name: `Mid ${A.suffix}`, parentId: null });
      expect(toRoot.status).toBe(200);
      expect(toRoot.body).toMatchObject({ path: '/', depth: 0, parentId: null });
      const rooted = await run.system(() => prisma.category.findMany({ where: { id: { in: [leaf.id, leaf2.id] } }, select: { id: true, path: true, depth: true } }));
      for (const row of rooted) expect(row).toMatchObject({ path: `/${mid.id}/`, depth: 1 });
      // And back under a parent two levels deep: depth + 2 for the whole subtree.
      const deep = await owner.patch(`/api/categories/${mid.id}`).send({ name: `Mid ${A.suffix}`, parentId: otherChild.id });
      expect(deep.status).toBe(200);
      expect(deep.body).toMatchObject({ path: `/${other.id}/${otherChild.id}/`, depth: 2 });
      const deepRows = await run.system(() => prisma.category.findMany({ where: { id: { in: [leaf.id, leaf2.id] } }, select: { path: true, depth: true } }));
      for (const row of deepRows) expect(row).toEqual({ path: `/${other.id}/${otherChild.id}/${mid.id}/`, depth: 3 });
    });
  });
});

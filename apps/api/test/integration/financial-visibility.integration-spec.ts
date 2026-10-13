/**
 * Financial visibility (release audit, 2026-10-12): a CASHIER or a VIEWER
 * (stock clerk) bills, looks up products and counts stock without seeing what
 * the shop paid for them, what it earns, what the stock is worth at cost, what
 * it owes its suppliers or what it spends. The routes that are financial as a
 * whole (suppliers, expenses, purchasing, purchase analytics, the Reports page,
 * the top-products list) answer them 403; every other answer leaves the cost,
 * profit, valuation and payable fields out (`FinancialFieldsInterceptor`),
 * which this suite proves by walking every GET route with the shop's real ids.
 * Owners and managers keep every figure.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { FINANCE_ROLES } from '../../src/auth/role-sets';
import { bootApp, createProduct, createShop, receiveStock, TestShop } from './pos-fixtures';
import { bearerToken, cashierOf, createUser, ownerOf } from '../security/security-fixtures';
import { enumerateHandlers, Handler } from './route-enumeration';
import { financialKeysIn } from './financial-keys';

jest.setTimeout(240_000);

/** The reads that are financial as a whole: FINANCE_ROLES only. */
const FINANCIAL_READS = [
  '/api/suppliers',
  '/api/suppliers/summary',
  '/api/expenses',
  '/api/expenses/summary',
  '/api/dashboard/analytics?range=month',
  '/api/dashboard/products',
  '/api/purchases',
  '/api/grn',
  '/api/purchase-returns',
  '/api/vendor-bills',
  '/api/supplier-credit-notes',
  '/api/purchase-analytics/dashboard',
  '/api/purchase-analytics/kpis',
  '/api/purchase-analytics/vendors',
  '/api/purchase-analytics/trends',
  '/api/purchase-analytics/categories',
  '/api/purchase-analytics/cost-analysis',
  '/api/purchase-events/statistics',
  '/api/purchase-events/dead-letter',
];

/** Query strings that make a read return the seeded rows rather than a 400 for a missing parameter. */
const QUERIES: Record<string, string> = {
  'GET /api/search': '?q=Tea',
  'GET /api/search/suggestions': '?q=Te',
  'GET /api/dashboard/analytics': '?range=month',
};

describe('Financial figures reach FINANCE_ROLES only', () => {
  let app: INestApplication;
  let shop: TestShop;
  let tokens: Record<'owner' | 'manager' | 'cashier' | 'viewer', string>;
  let ids: Record<string, string>;
  let handlers: Handler[];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (token: string, url: string) => http().get(url).set(as(token));

  beforeAll(async () => {
    app = await bootApp();
    shop = await createShop(app, 'finvis');
    tokens = {
      owner: await bearerToken(app, shop, ownerOf(shop)),
      manager: await bearerToken(app, shop, await createUser(app, shop, Role.MANAGER)),
      cashier: await bearerToken(app, shop, cashierOf(shop)),
      viewer: await bearerToken(app, shop, await createUser(app, shop, Role.VIEWER)),
    };

    const productId = await createProduct(app, shop, { key: 'Tea', costPrice: 60, sellingPrice: 100 });
    await receiveStock(app, shop, productId, 50);
    const supplier = await http().post('/api/suppliers').set(as(tokens.owner)).send({ name: `Wholesaler ${shop.suffix}`, phone: '9876501234' });
    expect(supplier.status).toBe(201);
    const expense = await http().post('/api/expenses').set(as(tokens.owner)).send({ description: 'Shop rent', category: 'Rent', amount: 5000, paymentMode: 'UPI' });
    expect(expense.status).toBe(201);

    expect((await http().post('/api/shifts/open').set(as(tokens.cashier)).send({ openingCash: 500 })).status).toBe(201);
    const sale = await http()
      .post('/api/billing/invoice')
      .set(as(tokens.cashier))
      .send({ idempotencyKey: randomUUID(), items: [{ productId, quantity: 2 }], payments: [{ tender: 'CASH', amount: 236 }] });
    expect(sale.status).toBe(201);
    // The checkout answer to the cashier carries no cost either.
    expect(financialKeysIn(sale.body)).toEqual([]);

    const product = await get(tokens.owner, `/api/products/${productId}`);
    const item = await get(tokens.owner, `/api/inventory-domain?take=200`);
    const inventoryItem = (item.body as Array<{ id: string; productId: string }>).find((row) => row.productId === productId);
    ids = {
      productId,
      invoiceId: sale.body.id ?? sale.body.invoice?.id,
      customerId: shop.customerId,
      supplierId: supplier.body.id,
      expenseId: expense.body.id,
      inventoryItemId: inventoryItem?.id ?? '',
      barcode: product.body.barcode,
    };
    expect(ids.invoiceId).toBeTruthy();
    expect(ids.inventoryItemId).toBeTruthy();
    handlers = enumerateHandlers(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the financial reads answer a cashier and a stock clerk 403 and a manager 200', async () => {
    for (const url of FINANCIAL_READS) {
      expect([url, (await get(tokens.cashier, url)).status]).toEqual([url, 403]);
      expect([url, (await get(tokens.viewer, url)).status]).toEqual([url, 403]);
      expect([url, (await get(tokens.manager, url)).status]).toEqual([url, 200]);
    }
    for (const url of [`/api/expenses/${ids.expenseId}/receipt`, `/api/purchases/${randomUUID()}`, `/api/grn/${randomUUID()}`]) {
      expect([url, (await get(tokens.cashier, url)).status]).toEqual([url, 403]);
    }
    // Each listed read is gated to exactly FINANCE_ROLES in the route metadata.
    for (const url of FINANCIAL_READS) {
      const handler = handlers.find((h) => h.method === 'GET' && h.path === url.split('?')[0]);
      expect([url, [...(handler?.roles ?? [])].sort()]).toEqual([url, [...FINANCE_ROLES].sort()]);
    }
  });

  it('a product, the invoice and the stock rows reach the cashier without the cost, and the manager with it', async () => {
    const asCashier = await get(tokens.cashier, `/api/products/${ids.productId}`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.body).toMatchObject({ id: ids.productId, sellingPrice: expect.anything(), mrp: expect.anything() });
    expect(asCashier.body).not.toHaveProperty('costPrice');
    const asManager = await get(tokens.manager, `/api/products/${ids.productId}`);
    expect(Number(asManager.body.costPrice)).toBe(60);

    const invoiceForCashier = await get(tokens.cashier, `/api/billing/invoices/${ids.invoiceId}`);
    expect(invoiceForCashier.status).toBe(200);
    expect(financialKeysIn(invoiceForCashier.body)).toEqual([]);
    expect(JSON.stringify(invoiceForCashier.body)).toContain('"totalAmount"');
    const invoiceForManager = await get(tokens.manager, `/api/billing/invoices/${ids.invoiceId}`);
    expect(financialKeysIn(invoiceForManager.body)).toContain('costPrice');
  });

  it('the dashboard leaves profit and stock value out for the cashier and computes them for the manager', async () => {
    const forCashier = await get(tokens.cashier, '/api/dashboard/summary');
    expect(forCashier.status).toBe(200);
    expect(forCashier.body.restrictedSections).toEqual(['todayProfit', 'inventoryValue']);
    expect(forCashier.body.failedSections).toEqual([]);
    expect(forCashier.body).not.toHaveProperty('todayProfit');
    expect(forCashier.body).not.toHaveProperty('inventoryValue');
    expect(forCashier.body.todaySales).toBe(236);

    const forManager = await get(tokens.manager, '/api/dashboard/summary');
    expect(forManager.body.restrictedSections).toEqual([]);
    expect(forManager.body.todayProfit).toBe(80);
    expect(forManager.body.inventoryValue).toBe(48 * 60);

    const insightsForCashier = await get(tokens.cashier, '/api/dashboard/insights');
    expect(insightsForCashier.status).toBe(200);
    expect(insightsForCashier.body.restrictedSections).toEqual(['topProduct']);
    expect(insightsForCashier.body.topProduct).toBeNull();
    const insightsForManager = await get(tokens.manager, '/api/dashboard/insights');
    expect(insightsForManager.body.restrictedSections).toEqual([]);
    expect(insightsForManager.body.topProduct).toMatchObject({ productId: ids.productId, grossProfit: 80 });
  });

  it('walking every GET route with the shop’s ids, no answer to a cashier or a stock clerk carries a financial field', async () => {
    const fill = (path: string) =>
      path
        .replace(':productId', ids.productId)
        .replace(':inventoryItemId', ids.inventoryItemId)
        .replace(':code', ids.barcode)
        .replace(':customerId', ids.customerId);
    // `:id` means a different row per controller: the shop's row for the controllers that have one.
    const idFor = (path: string): string | undefined => {
      if (path.startsWith('/api/products/')) return ids.productId;
      if (path.startsWith('/api/billing/invoices/')) return ids.invoiceId;
      if (path.startsWith('/api/customers/')) return ids.customerId;
      if (path.startsWith('/api/inventory-domain/')) return ids.inventoryItemId;
      if (path.startsWith('/api/suppliers/')) return ids.supplierId;
      if (path.startsWith('/api/expenses/')) return ids.expenseId;
      return undefined;
    };
    const reads = handlers.filter((h) => h.method === 'GET' && !h.isPublic);
    const leaks: string[] = [];
    let served = 0;
    for (const who of ['cashier', 'viewer'] as const) {
      for (const handler of reads) {
        let url = fill(handler.path);
        const id = idFor(url);
        if (url.includes(':id')) {
          if (!id) continue;
          url = url.replace(':id', id);
        }
        if (/:[A-Za-z]/.test(url)) continue;
        const res = await get(tokens[who], url + (QUERIES[handler.key] ?? ''));
        expect([who, handler.key, res.status < 500]).toEqual([who, handler.key, true]);
        if (res.status >= 300 || !String(res.headers['content-type'] ?? '').includes('json')) continue;
        served++;
        const keys = financialKeysIn(res.body);
        if (keys.length) leaks.push(`${who} ${handler.key}: ${keys.join(', ')}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(served).toBeGreaterThan(40);

    // The walk would have seen them: the manager's answers do carry them.
    const managerProducts = await get(tokens.manager, '/api/products');
    expect(financialKeysIn(managerProducts.body)).toContain('costPrice');
  });
});

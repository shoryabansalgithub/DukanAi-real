import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { cashierOf, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, TestShop } from './pos-fixtures';

/**
 * Roadmap 9.15 (OWASP ASVS L2, docs/security/ASVS_L2.md): the controls the
 * review added that no other suite covers. Every answer carries
 * `Cache-Control: no-store` (8.2.1) and a refused role check is logged with
 * who, what and why (7.2.2).
 */
describe('ASVS controls (roadmap 9.15)', () => {
  let app: INestApplication;
  let shop: TestShop;
  let productId: string;

  beforeAll(async () => {
    app = await bootApp();
    shop = await createShop(app, 'asvs');
    productId = await createProduct(app, shop, { key: 'ASVS', sellingPrice: 10, costPrice: 5 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('every answer is Cache-Control: no-store, the probes and refusals included (8.2.1)', async () => {
    const anonymous = await request(app.getHttpServer()).get('/api/products');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const health = await request(app.getHttpServer()).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    const owner = await (await httpAs(app, shop, ownerOf(shop))).get('/api/products?limit=1');
    expect(owner.status).toBe(200);
    expect(owner.headers['cache-control']).toBe('no-store');
  });

  it('a refused role check is logged with the user, the handler and the required roles (7.2.2)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const refused = await (await httpAs(app, shop, cashierOf(shop))).delete(`/api/products/${productId}`);
      expect(refused.status).toBe(403);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith(`Access denied for user ${shop.cashierId} (CASHIER)`));
      expect(line).toMatch(/to \w+\.\w+: requires /);
    } finally {
      warn.mockRestore();
    }
  });
});

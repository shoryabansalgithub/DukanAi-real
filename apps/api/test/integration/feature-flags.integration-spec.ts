/**
 * Roadmap 9.23: pausing a broken feature without a deploy. The real AppModule
 * runs with `FeatureFlagsConfig` replaced by a mutable instance, so one boot
 * walks each switch on and off the way a restart with a changed
 * `FEATURE_<NAME>_ENABLED` would:
 *
 *  - a paused feature answers 503 `FEATURE_PAUSED` to new work, with the
 *    feature named, and only after authentication and authorization
 *    (nobody: 401, a VIEWER: 403);
 *  - what the shop already recorded stays readable, and a replay of a
 *    document committed before the pause (same idempotency key) is still
 *    answered: a cashier retrying a lost answer gets the sale, not an error;
 *  - every other feature keeps working (a cash sale while credit is paused).
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { FeatureFlagsConfig } from '../../src/config/domains/feature-flags.config';
import { FEATURES, FeatureName } from '../../src/common/features/feature-catalogue';
import { bootApp, createProduct, createShop, httpTarget, receiveStock, TestShop } from './pos-fixtures';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';

describe('Feature pause switches (roadmap 9.23)', () => {
  let app: INestApplication;
  let shop: TestShop;
  let productId: string;
  let owner: Awaited<ReturnType<typeof httpAs>>;
  let viewer: Awaited<ReturnType<typeof httpAs>>;
  const flags = new FeatureFlagsConfig();

  const pause = (feature: FeatureName) => {
    (flags as unknown as Record<string, boolean>)[FEATURES[feature].flag] = false;
  };
  const resume = (feature: FeatureName) => {
    (flags as unknown as Record<string, boolean>)[FEATURES[feature].flag] = true;
  };
  const expectPaused = (res: request.Response, feature: FeatureName) => {
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('FEATURE_PAUSED');
    expect(res.body.details).toMatchObject({ feature });
    expect(res.body.message).toContain(FEATURES[feature].label);
  };

  const sale = (key: string, payments: object[], extra: object = {}) =>
    owner.post('/api/billing/invoice').send({ idempotencyKey: key, items: [{ productId, quantity: 1 }], payments, ...extra });

  beforeAll(async () => {
    app = await bootApp((b) => b.overrideProvider(FeatureFlagsConfig).useValue(flags));
    shop = await createShop(app, 'flags', { creditLimit: 100000 });
    productId = await createProduct(app, shop, { key: 'flag', sellingPrice: 100, gstRate: 'ZERO' });
    await receiveStock(app, shop, productId, 100);
    owner = await httpAs(app, shop, ownerOf(shop));
    viewer = await httpAs(app, shop, await createUser(app, shop, Role.VIEWER));
    const shift = await owner.post('/api/shifts/open').send({ openingCash: 1000 });
    expect(shift.status).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    for (const name of Object.keys(FEATURES) as FeatureName[]) resume(name);
  });

  it('credit sales: new credit work is refused, its replay and cash sales are not', async () => {
    const before = randomUUID();
    const credit: object[] = [];
    const first = await sale(before, credit, { customerId: shop.customerId, udharAmount: 100 });
    expect(first.status).toBe(201);

    pause('credit_sales');
    const replay = await sale(before, credit, { customerId: shop.customerId, udharAmount: 100 });
    expect(replay.status).toBe(200); // a replay answers 200 (contract §3)
    expect(replay.body.invoice.id).toBe(first.body.invoice.id);

    expectPaused(await sale(randomUUID(), credit, { customerId: shop.customerId, udharAmount: 100 }), 'credit_sales');
    const cash = await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }]);
    expect(cash.status).toBe(201);
  });

  it('returns: a new return is refused, the replay of one made before the pause is answered', async () => {
    const original = await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }]);
    expect(original.status).toBe(201);
    const key = randomUUID();
    const body = { idempotencyKey: key, invoiceId: original.body.invoice.id, reason: 'DAMAGED' };
    const made = await owner.post('/api/billing/returns').send(body);
    expect(made.status).toBe(201);

    pause('returns');
    const replay = await owner.post('/api/billing/returns').send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.invoice.id).toBe(made.body.invoice.id);

    const another = await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }]);
    expectPaused(await owner.post('/api/billing/returns').send({ idempotencyKey: randomUUID(), invoiceId: another.body.invoice.id, reason: 'DAMAGED' }), 'returns');
    // what was sold is still readable
    expect((await owner.get(`/api/billing/invoices/${another.body.invoice.id}`)).status).toBe(200);
  });

  it('cancellations: an invoice cancelled before the pause is answered again, a new cancel is refused', async () => {
    const first = await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }]);
    const second = await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }]);
    expect((await owner.post(`/api/billing/invoices/${first.body.invoice.id}/cancel`).send({ reason: 'wrong item' })).status).toBe(200);

    pause('cancellations');
    const again = await owner.post(`/api/billing/invoices/${first.body.invoice.id}/cancel`).send({ reason: 'wrong item' });
    expect(again.status).toBe(200);
    expect(again.body.invoice.status).toBe('CANCELLED');
    expectPaused(await owner.post(`/api/billing/invoices/${second.body.invoice.id}/cancel`).send({ reason: 'wrong item' }), 'cancellations');
    const still = await owner.get(`/api/billing/invoices/${second.body.invoice.id}`);
    expect(still.body.status).toBe('COMPLETED');
  });

  it('route gates refuse writes after 401/403, keep reads, and name the feature', async () => {
    pause('procurement');
    pause('ocr');
    pause('imports');
    pause('documents');
    pause('media');

    // authentication and authorization still come first
    expect((await request(httpTarget(app)).post('/api/ocr/scan-bill')).status).toBe(401);
    expect((await viewer.post('/api/purchases').send({})).status).toBe(403);

    expectPaused(await owner.post('/api/purchases').send({}), 'procurement');
    expectPaused(await owner.post('/api/grn').send({}), 'procurement');
    expectPaused(await owner.post('/api/vendor-bills').send({}), 'procurement');
    expectPaused(await owner.post('/api/ocr/scan-bill'), 'ocr');
    expectPaused(await owner.post('/api/imports/products/upload'), 'imports');
    expectPaused(await owner.post('/api/storage/bills/Walk-in/b1'), 'documents');
    expectPaused(await owner.post('/api/media/tag').send({}), 'media');

    expect((await owner.get('/api/purchases')).status).toBe(200);
    expect((await owner.get('/api/imports/jobs')).status).toBe(200);

    // unrelated features are untouched
    expect((await sale(randomUUID(), [{ tender: 'CASH', amount: 100 }])).status).toBe(201);
  });

  it('dashboard insights pause their read too; the summary keeps working', async () => {
    expect((await owner.get('/api/dashboard/insights')).status).toBe(200);
    pause('dashboard_insights');
    expectPaused(await owner.get('/api/dashboard/insights'), 'dashboard_insights');
    expect((await owner.get('/api/dashboard/summary')).status).toBe(200);
  });
});

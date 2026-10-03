/**
 * Roadmap 4.1 (audit P2-1): the six controllers that used to read the
 * never-set `req.shop` answered 500 on every call. This walks every one of
 * their routes as the shop OWNER, as a VIEWER and as the OWNER of another
 * shop holding the first shop's ids: no route may answer 500, reads work,
 * writes are role-gated, foreign ids answer 404/403/400, and the latent
 * issues the audit named (validation state per shop, SKU identity per shop,
 * webhook secret exposure, media ownership) stay fixed. The import route
 * is followed to the worker, which must run in the shop's tenant context.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bearerToken, createUser, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { OUTBOUND_RESOLVER } from '../../src/common/net/outbound-url-guard';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('scaffolding routes (roadmap 4.1): media, validation, identity, imports, webhooks, events', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let B: TestShop;
  let owner: Awaited<ReturnType<typeof httpAs>>;
  let viewer: Awaited<ReturnType<typeof httpAs>>;
  let foreign: Awaited<ReturnType<typeof httpAs>>;
  let ownerToken: string;
  let foreignToken: string;
  let productA: string;
  let variantA: string;
  let sku: string;

  const notFoundOrForbidden = (status: number) => expect([400, 403, 404]).toContain(status);

  beforeAll(async () => {
    // Webhook registration resolves the host (roadmap 4.8); the test hosts have no DNS here.
    app = await bootApp((b) => b.overrideProvider(OUTBOUND_RESOLVER).useValue(async () => [{ address: '93.184.216.34', family: 4 }]));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'scafA');
    B = await createShop(app, 'scafB');
    owner = await httpAs(app, A, ownerOf(A));
    viewer = await httpAs(app, A, await createUser(app, A, Role.VIEWER));
    foreign = await httpAs(app, B, ownerOf(B));
    ownerToken = await bearerToken(app, A, ownerOf(A));
    foreignToken = await bearerToken(app, B, ownerOf(B));
    productA = await createProduct(app, A, { key: 'scaf' });
    sku = `VAR-${A.suffix}`;
    variantA = (await run.system(() => prisma.productVariant.create({ data: { shopId: A.shopId, productId: productA, sku } }))).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('media', () => {
    let assetId: string;
    let referenceId: string;

    it('OWNER uploads to an own product; a VIEWER may not; the foreign owner gets 404', async () => {
      const res = await request(app.getHttpServer()).post(`/api/media/upload/product/${productA}`).set('Authorization', `Bearer ${ownerToken}`).field('isPrimary', 'true').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      assetId = res.body.id;
      const gallery = await owner.get(`/api/media/product/${productA}`);
      expect(gallery.status).toBe(200);
      expect(gallery.body).toHaveLength(1);
      referenceId = gallery.body[0].id;
      expect((await viewer.get(`/api/media/product/${productA}`)).status).toBe(200);
      const viewerUpload = await request(app.getHttpServer()).post(`/api/media/upload/product/${productA}`).set('Authorization', `Bearer ${await bearerToken(app, A, await createUser(app, A, Role.VIEWER))}`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
      expect(viewerUpload.status).toBe(403);
      const foreignUpload = await request(app.getHttpServer()).post(`/api/media/upload/product/${productA}`).set('Authorization', `Bearer ${foreignToken}`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
      expect(foreignUpload.status).toBe(404);
      expect((await foreign.get(`/api/media/product/${productA}`)).body).toEqual([]);
      expect((await owner.get(`/api/media/variant/${variantA}`)).status).toBe(200);
    });

    it('tag and order act on owned assets and references only', async () => {
      const tagged = await owner.post('/api/media/tag').send({ assetId, tag: 'Hero' });
      expect(tagged.status).toBe(201);
      expect(tagged.body.tag.name).toBe('Hero');
      expect((await foreign.post('/api/media/tag').send({ assetId, tag: 'Hero' })).status).toBe(404);
      expect((await viewer.post('/api/media/tag').send({ assetId, tag: 'Hero' })).status).toBe(403);
      const ordered = await owner.post('/api/media/order').send({ productId: productA, referenceIds: [referenceId] });
      expect(ordered.status).toBe(201);
      expect((await foreign.post('/api/media/order').send({ productId: productA, referenceIds: [referenceId] })).status).toBe(404);
      expect((await owner.post('/api/media/order').send({ referenceIds: [referenceId] })).status).toBe(400);
    });
  });

  describe('validation', () => {
    it('validates an own product, records state per shop, and never validates a foreign one', async () => {
      const res = await owner.post(`/api/products/${productA}/validate`).send({});
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('qualityScore');
      expect((await owner.get(`/api/products/${productA}/quality`)).status).toBe(200);
      expect((await owner.get(`/api/products/${productA}/issues`)).status).toBe(200);
      expect((await viewer.get(`/api/products/${productA}/quality`)).status).toBe(200);
      expect((await owner.get('/api/products/validation/rules')).status).toBe(200);
      expect((await viewer.post(`/api/products/${productA}/validate`).send({})).status).toBe(403);
      expect((await foreign.post(`/api/products/${productA}/validate`).send({})).status).toBe(404);
      notFoundOrForbidden((await foreign.get(`/api/products/${productA}/quality`)).status);
      expect((await foreign.post('/api/products/bulk-validation').send({ productIds: [productA] })).status).toBe(404);
      const bulk = await owner.post('/api/products/bulk-validation').send({ productIds: [productA] });
      expect(bulk.status).toBe(201);
      expect(bulk.body.queued).toBe(1);
      expect(await run.system(() => prisma.productQualityScore.count({ where: { productId: productA, shopId: A.shopId } }))).toBe(1);
    });
  });

  describe('identity', () => {
    it('assigns barcodes to own products and variants, keeps SKU identities per shop, and refuses foreign ids', async () => {
      const code = `${Date.now()}`.slice(-8);
      const res = await owner.post(`/api/product-identity/products/${productA}/barcode`).send({ code, format: 'CODE128' });
      expect(res.status).toBe(201);
      expect((await owner.post(`/api/product-identity/products/${productA}/barcode`).send({ code, format: 'CODE128' })).status).toBe(409);
      expect((await foreign.post(`/api/product-identity/products/${productA}/barcode`).send({ code: `${code}9`, format: 'CODE128' })).status).toBe(404);
      expect((await viewer.post(`/api/product-identity/products/${productA}/barcode`).send({ code: `${code}8`, format: 'CODE128' })).status).toBe(403);

      const variantCode = `V${code}`;
      expect((await owner.post(`/api/product-identity/variants/${variantA}/barcode`).send({ code: variantCode, format: 'CODE128' })).status).toBe(201);
      // Shop B may use the same SKU for its own variant: identities are unique per shop now.
      const productB = await createProduct(app, B, { key: 'scaf' });
      const variantB = await run.system(() => prisma.productVariant.create({ data: { shopId: B.shopId, productId: productB, sku } }));
      expect((await foreign.post(`/api/product-identity/variants/${variantB.id}/barcode`).send({ code: variantCode, format: 'CODE128' })).status).toBe(201);
      expect(await run.system(() => prisma.variantIdentity.count({ where: { sku } }))).toBe(2);

      expect((await owner.get(`/api/product-identity/barcode/search?q=${code}`)).status).toBe(200);
      expect((await owner.get(`/api/product-identity/barcode/search?q=${sku}`)).body.variantId).toBe(variantA);
      expect((await foreign.get(`/api/product-identity/barcode/search?q=${code}`)).status).toBe(404);
      const history = await owner.get(`/api/product-identity/barcode/${code}/history`);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      expect((await owner.get(`/api/product-identity/barcode/${sku}/history`)).body).toEqual([]);
      const render = await owner.get(`/api/product-identity/barcode/${code}/render?format=CODE128`);
      expect(render.status).toBe(200);
      expect(render.headers['content-type']).toContain('image/png');
      expect((await owner.get(`/api/product-identity/barcode/${code}/render?format=NOPE`)).status).toBe(400);
    });
  });

  describe('imports', () => {
    it('queues an import for the shop, the worker runs it in the shop context, and foreign shops cannot read the job', async () => {
      const csv = Buffer.from(`SKU,Name,sellingPrice,costPrice,mrp\nIMP-${A.suffix},Imported ${A.suffix},10,5,12\n,No sku,1,1,1\n`);
      const res = await request(app.getHttpServer()).post('/api/imports/products/upload').set('Authorization', `Bearer ${ownerToken}`).field('mode', 'UPSERT').attach('file', csv, { filename: 'products.csv', contentType: 'text/csv' });
      expect(res.status).toBe(201);
      const jobId = res.body.jobId as string;
      expect((await owner.post('/api/imports/products/upload').send({})).status).toBe(400);
      const bad = await request(app.getHttpServer()).post('/api/imports/products/upload').set('Authorization', `Bearer ${ownerToken}`).field('mode', 'BOGUS').attach('file', csv, { filename: 'products.csv', contentType: 'text/csv' });
      expect(bad.status).toBe(400);

      let status = 'PENDING';
      for (let i = 0; i < 60 && (status === 'PENDING' || status === 'PROCESSING'); i++) {
        await new Promise((r) => setTimeout(r, 500));
        status = (await owner.get(`/api/imports/jobs/${jobId}`)).body.status;
      }
      expect(['COMPLETED', 'PARTIAL_SUCCESS']).toContain(status);
      expect(await run.system(() => prisma.product.count({ where: { shopId: A.shopId, sku: `IMP-${A.suffix}` } }))).toBe(1);
      const errors = await owner.get(`/api/imports/jobs/${jobId}/errors`);
      expect(errors.status).toBe(200);
      expect(errors.body).toHaveLength(1);
      expect((await viewer.get(`/api/imports/jobs/${jobId}`)).status).toBe(200);
      expect((await foreign.get(`/api/imports/jobs/${jobId}`)).status).toBe(404);
      expect((await foreign.get(`/api/imports/jobs/${jobId}/errors`)).status).toBe(404);
    });
  });

  describe('webhooks', () => {
    it('shows a generated secret once, never on reads, and scopes every route to the shop', async () => {
      const created = await owner.post('/api/webhooks').send({ url: 'https://hooks.example.test/a', events: ['ProductCreated'] });
      expect(created.status).toBe(201);
      expect(created.body.secret).toMatch(/^[0-9a-f]{64}$/);
      const supplied = await owner.post('/api/webhooks').send({ url: 'https://hooks.example.test/b', secret: 'my-own-secret-value-16' });
      expect(supplied.status).toBe(201);
      expect(supplied.body).not.toHaveProperty('secret');

      const list = await owner.get('/api/webhooks');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.every((e: Record<string, unknown>) => !('secret' in e))).toBe(true);
      expect((await viewer.get('/api/webhooks')).status).toBe(403);
      expect((await viewer.post('/api/webhooks').send({ url: 'https://hooks.example.test/c' })).status).toBe(403);
      expect((await foreign.get('/api/webhooks')).body).toEqual([]);

      const id = created.body.id as string;
      expect((await owner.get(`/api/webhooks/${id}/deliveries`)).status).toBe(200);
      expect((await foreign.get(`/api/webhooks/${id}/deliveries`)).status).toBe(404);
      expect((await foreign.delete(`/api/webhooks/${id}`)).status).toBe(404);
      expect((await owner.delete(`/api/webhooks/${id}`)).status).toBe(200);
      expect((await owner.delete(`/api/webhooks/${id}`)).status).toBe(404);
      const stored = await run.system(() => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: supplied.body.id } }));
      expect(stored.secret).toBe('my-own-secret-value-16');
    });
  });

  describe('events', () => {
    it('lists the shop\'s events and metrics; replay is MANAGER+ and scoped', async () => {
      const list = await owner.get('/api/events');
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.every((e: { shopId: string }) => e.shopId === A.shopId)).toBe(true);
      expect((await viewer.get('/api/events/metrics')).status).toBe(200);
      expect((await viewer.post('/api/events/replay').send({ eventId: randomUUID() })).status).toBe(403);
      expect((await owner.post('/api/events/replay').send({})).status).toBe(400);
      expect((await owner.post('/api/events/replay').send({ eventId: randomUUID() })).status).toBe(400);
      const event = await run.system(() => prisma.productEventLog.findFirst({ where: { shopId: A.shopId } }));
      if (event) {
        expect((await owner.post('/api/events/replay').send({ eventId: event.eventId })).status).toBe(201);
        expect((await foreign.post('/api/events/replay').send({ eventId: event.eventId })).status).toBe(400);
      }
    });
  });
});

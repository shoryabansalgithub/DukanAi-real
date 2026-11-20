/**
 * Release-readiness audit, operations findings proven over the real stack
 * (MySQL, Redis, the booted AppModule): bounded job retention on every queue
 * (R1 / R7), case-sensitive routing (R13d), the webhook endpoint cap (R2),
 * a race-safe system-events marker (R10), the media file route and long file
 * names (P3), import report roles (item 17), invoice evidence ownership (T6d)
 * and a cron lock held for the whole run (R9).
 */
import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UploadConfig } from '../../src/config/domains/upload.config';
import { EventsFeatureConfig } from '../../src/config/domains/features/events-feature.config';
import { queueInstances } from '../../src/common/lifecycle/queue-readiness';
import { isBoundedRemoval } from '../../src/common/queues/job-options';
import { WEBHOOK_DELIVERY_QUEUE } from '../../src/product-events/webhook-delivery.queue';
import { OUTBOUND_RESOLVER, OutboundResolver } from '../../src/common/net/outbound-url-guard';
import { markerIdFor, SystemEventsProcessor } from '../../src/common/outbox/system-events.processor';
import { CronLockService } from '../../src/common/cron-lock/cron-lock.service';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { bearerToken, createUser, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

const PUBLIC_IP = '93.184.216.34';
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const png = (fill: number) => Buffer.concat([PNG_HEADER, Buffer.alloc(2048, fill)]);
const LONG_NAME = `${'a'.repeat(200)}.png`;

describe('Operations audit findings (release readiness)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let B: TestShop;
  let ownerToken: string;
  const tempDir = path.resolve(process.cwd(), 'uploads', 'tmp-ops-audit');
  const tempFiles = () => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []);
  const resolver: OutboundResolver = async () => [{ address: PUBLIC_IP, family: 4 }];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const uploadConfig = Object.assign(new UploadConfig(), { tempDir: 'uploads/tmp-ops-audit' });
    app = await bootApp((b) => b.overrideProvider(UploadConfig).useValue(uploadConfig).overrideProvider(OUTBOUND_RESOLVER).useValue(resolver));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'opsA');
    B = await createShop(app, 'opsB');
    ownerToken = await bearerToken(app, A, ownerOf(A));
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('R1 / R7: every registered queue removes its finished and failed jobs within a bound; webhook delivery retries for minutes', () => {
    const queues = queueInstances(app.get(ModulesContainer)).queues.filter((q): q is Queue => q instanceof Queue);
    expect(queues.length).toBeGreaterThanOrEqual(5);
    for (const queue of queues) {
      const opts = queue.defaultJobOptions;
      expect([queue.name, isBoundedRemoval(opts.removeOnComplete), isBoundedRemoval(opts.removeOnFail)]).toEqual([queue.name, true, true]);
    }
    const events = app.get(EventsFeatureConfig);
    const webhook = queues.find((q) => q.name === WEBHOOK_DELIVERY_QUEUE);
    expect(webhook?.defaultJobOptions).toMatchObject({ attempts: events.webhookDeliveryAttempts, backoff: { type: 'exponential', delay: events.webhookRetryBackoffMs } });
    expect(events.webhookDeliveryAttempts).toBe(8);
    expect(events.webhookRetryBackoffMs).toBe(30_000);
  });

  it('R13: routing is case-sensitive, so an edge rule on /api/metrics cannot be bypassed as /API/metrics', async () => {
    expect((await http().get('/api/health')).status).toBe(200);
    expect((await http().get('/API/health')).status).toBe(404);
    expect((await http().get('/api/HEALTH')).status).toBe(404);
    expect((await http().get('/API/metrics')).status).toBe(404);
    expect((await http().get('/Api/Metrics')).status).toBe(404);
  });

  it('R2: a shop registers at most EVENTS_WEBHOOK_MAX_ENDPOINTS_PER_SHOP endpoints, also when the requests race', async () => {
    const limit = app.get(EventsFeatureConfig).webhookMaxEndpointsPerShop;
    const owner = await httpAs(app, A, ownerOf(A));
    const answers = await Promise.all(
      Array.from({ length: limit + 3 }, (_, i) => owner.post('/api/webhooks').send({ url: `https://hooks-${i}.example.test/in`, events: ['*'] })),
    );
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(limit);
    const refused = answers.filter((r) => r.status === 409);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.body).toMatchObject({ code: 'WEBHOOK_ENDPOINT_LIMIT', details: { limit } });
    expect(await run.system(() => prisma.webhookEndpoint.count({ where: { shopId: A.shopId } }))).toBe(limit);
    // Another shop has its own allowance.
    expect((await (await httpAs(app, B, ownerOf(B))).post('/api/webhooks').send({ url: 'https://hooks-b.example.test/in', events: ['*'] })).status).toBe(201);
  });

  it('R10: two workers on the same system event raise its notifications once and only the live claim settles the row', async () => {
    const productId = await createProduct(app, A, { key: 'OPSLOW', reorderPoint: 10 }); // stock 0: low
    const event = await run.system(() =>
      prisma.outboxEvent.create({
        data: { shopId: A.shopId, type: 'INVOICE_CREATED', status: 'CLAIMED', claimedAt: new Date(), retryCount: 0, entityType: 'Invoice', entityId: `inv-${randomUUID()}`, payload: { invoiceId: 'inv-ops', items: [{ productId }] } },
      }),
    );
    const job = (jobId: string) =>
      ({ id: jobId, name: 'INVOICE_CREATED', opts: { jobId, attempts: 3 }, attemptsMade: 0, data: { eventId: event.id, correlationId: 'ops-race', shopId: A.shopId, userId: A.cashierId, payload: event.payload } }) as unknown as Job;
    const processor = app.get(SystemEventsProcessor);

    const outcomes = await Promise.all([processor.process(job(`${event.id}.0`) as never), processor.process(job(`${event.id}.0`) as never)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['processed', 'skipped-duplicate']);
    const markers = await run.system(() => prisma.auditLog.findMany({ where: { shopId: A.shopId, entity: 'OutboxEvent', entityId: event.id }, select: { id: true } }));
    expect(markers).toEqual([{ id: markerIdFor(event.id) }]);
    expect(await run.system(() => prisma.notification.count({ where: { shopId: A.shopId, type: 'LOW_STOCK', entityId: productId } }))).toBe(1);
    expect((await run.system(() => prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }))).status).toBe('DONE');

    // A late worker of an older claim does not touch a row a newer claim holds.
    await run.system(() => prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'CLAIMED', retryCount: 2 } }));
    await expect(processor.process(job(`${event.id}.0`) as never)).resolves.toEqual({ status: 'skipped-duplicate' });
    expect(await run.system(() => prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }))).toMatchObject({ status: 'CLAIMED', retryCount: 2 });
    await run.system(() => prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'DONE' } }));
  });

  describe('media files (audit P3)', () => {
    let productId: string;
    const upload = (body: Buffer, filename: string, token = ownerToken) =>
      http().post(`/api/media/upload/product/${productId}`).set('Authorization', `Bearer ${token}`).attach('file', body, { filename, contentType: 'image/png' });

    beforeAll(async () => {
      productId = await createProduct(app, A, { key: 'OPSMEDIA' });
    });

    it('the gallery carries the store-relative path and a cdnUrl that serves the bytes to the shop only', async () => {
      const bytes = png(0x2b);
      const uploaded = await upload(bytes, 'shelf.png');
      expect(uploaded.status).toBe(201);
      const assetId = uploaded.body.id as string;

      const gallery = await http().get(`/api/media/product/${productId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(gallery.status).toBe(200);
      const storage = gallery.body[0].asset.storage;
      expect(storage.path).toMatch(/^media\/[0-9a-f]{2}\/[0-9a-f]+\.png$/);
      expect(storage.cdnUrl).toBe(`/api/media/assets/${assetId}/file`);
      expect(JSON.stringify(gallery.body)).not.toContain(process.cwd());

      const file = await http().get(storage.cdnUrl).set('Authorization', `Bearer ${ownerToken}`).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect((file.body as Buffer).equals(bytes)).toBe(true);

      expect((await http().get(storage.cdnUrl)).status).toBe(401);
      expect((await http().get(storage.cdnUrl).set('Authorization', `Bearer ${await bearerToken(app, B, ownerOf(B))}`)).status).toBe(404);
      expect((await http().get(`/api/media/assets/${randomUUID()}/file`).set('Authorization', `Bearer ${ownerToken}`)).status).toBe(404);
      expect((await http().get(`${storage.cdnUrl}?size=thumb`).set('Authorization', `Bearer ${ownerToken}`)).status).toBe(400);
    });

    it('a file name over 191 characters is refused before anything is stored (media, imports, storage)', async () => {
      const before = await run.system(() => prisma.mediaAsset.count({ where: { shopId: A.shopId } }));
      const media = await upload(png(0x2c), LONG_NAME);
      expect([media.status, media.body.code]).toEqual([400, 'UPLOAD_FILE_NAME_TOO_LONG']);
      expect(await run.system(() => prisma.mediaAsset.count({ where: { shopId: A.shopId } }))).toBe(before);

      const imports = await http()
        .post('/api/imports/products/upload')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', Buffer.from('sku,name\nX,Y\n'), { filename: `${'b'.repeat(200)}.csv`, contentType: 'text/csv' });
      expect([imports.status, imports.body.code]).toEqual([400, 'UPLOAD_FILE_NAME_TOO_LONG']);
      expect(tempFiles()).toEqual([]);

      const bill = await http().post(`/api/storage/bills/${A.customerId}/long-1`).set('Authorization', `Bearer ${ownerToken}`).attach('image', png(0x2d), { filename: LONG_NAME, contentType: 'image/png' });
      expect(bill.status).toBe(400);
    });
  });

  it('item 17: an import job\'s rows, errors and report are for management; the job itself never names the server file', async () => {
    const upload = await http()
      .post('/api/imports/customers/upload')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('dryRun', 'true')
      .attach('file', Buffer.from('name,phone\nAsha,7012345601\n'), { filename: 'customers.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(201);
    const jobId = upload.body.jobId as string;
    const viewer = await httpAs(app, A, await createUser(app, A, Role.VIEWER));
    const cashier = await httpAs(app, A, await createUser(app, A, Role.CASHIER));
    const manager = await httpAs(app, A, await createUser(app, A, Role.MANAGER));
    for (const suffix of ['rows', 'errors', 'report']) {
      const url = `/api/imports/jobs/${jobId}/${suffix}`;
      expect([url, (await viewer.get(url)).status]).toEqual([url, 403]);
      expect([url, (await cashier.get(url)).status]).toEqual([url, 403]);
      expect([url, (await manager.get(url)).status]).toEqual([url, 200]);
    }
    const job = await viewer.get(`/api/imports/jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect(job.body.fileUrl).toBeUndefined();
    expect(JSON.stringify(job.body)).not.toContain(process.cwd());
  });

  it('T6d: invoice evidence is stored only for an invoice of the shop sold to that customer', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20)]);
    const store = (customerId: string, invoiceId: string) =>
      http().post(`/api/storage/invoices/${customerId}/${invoiceId}`).set('Authorization', `Bearer ${ownerToken}`).field('jsonContent', '{}').attach('pdf', pdf, { filename: 'inv.pdf', contentType: 'application/pdf' });
    const unknown = await store(A.customerId, randomUUID());
    expect([unknown.status, unknown.body.code]).toEqual([404, 'STORAGE_INVOICE_NOT_FOUND']);
    const walkIn = await store('Walk-in', randomUUID());
    expect([walkIn.status, walkIn.body.code]).toEqual([404, 'STORAGE_INVOICE_NOT_FOUND']);
  });

  it('R9: a cron lock is extended while its run lasts longer than the TTL, and released after', async () => {
    const locks = app.get(CronLockService);
    const resource = `cron:ops-audit-${randomUUID()}`;
    let release!: () => void;
    const holding = locks.withLock(resource, 3_000, () => new Promise<string>((resolve) => (release = () => resolve('first'))));
    await new Promise((r) => setTimeout(r, 4_500)); // past the TTL: only an extension keeps it
    await expect(locks.withLock(resource, 3_000, async () => 'second')).resolves.toBeNull();
    release();
    await expect(holding).resolves.toBe('first');
    await expect(locks.withLock(resource, 3_000, async () => 'third')).resolves.toBe('third');
  });
});

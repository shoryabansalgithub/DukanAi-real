/**
 * Roadmap 4.7 / 4.8: one outbox semantic (claim, worker settles, stale-claim
 * reaper, backoff, operator retry) and one webhook delivery path (URL vetted
 * at registration and again at send time, pinned address, timestamped HMAC).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EventsFeatureConfig } from '../../src/config/domains/features/events-feature.config';
import { OutboxReaperService } from '../../src/common/outbox/outbox-reaper.service';
import { OutboxClaimService } from '../../src/common/outbox/outbox-claim.service';
import { OutboxProcessorWorker } from '../../src/product-events/workers/outbox.worker';
import { PRODUCT_RELAY_TYPE_PREFIXES } from '../../src/common/outbox/outbox-routing';
import { OUTBOUND_RESOLVER, OutboundResolver } from '../../src/common/net/outbound-url-guard';
import { WebhookHttpClient, WebhookPostRequest } from '../../src/product-events/services/webhook-http-client';
import { signWebhookPayload } from '../../src/product-events/services/webhook-dispatcher.service';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { cashierOf, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);
const PUBLIC_IP = '93.184.216.34';
const HOUR_MS = 3600 * 1000;

async function waitFor<T>(probe: () => Promise<T | undefined | null | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Outbox and webhooks (roadmap 4.7 / 4.8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let reaper: OutboxReaperService;
  let claims: OutboxClaimService;
  let productRelay: OutboxProcessorWorker;
  let config: EventsFeatureConfig;
  let A: TestShop;
  let B: TestShop;

  /** DNS answers per hostname; a host not listed resolves to the public address. */
  const dns = new Map<string, string>([['private.example.test', '10.0.0.5']]);
  const resolver: OutboundResolver = async (hostname) => [{ address: dns.get(hostname) ?? PUBLIC_IP, family: 4 }];
  const requests: WebhookPostRequest[] = [];
  const http = { post: jest.fn(async (req: WebhookPostRequest) => (requests.push(req), { status: 200 })) };

  const outboxRow = (shop: TestShop, data: Partial<{ type: string; status: string; claimedAt: Date | null; createdAt: Date; retryCount: number; nextAttemptAt: Date | null; payload: object }>) =>
    run.system(() =>
      prisma.outboxEvent.create({
        data: {
          shopId: shop.shopId,
          type: data.type ?? 'ProductCreated',
          payload: data.payload ?? { productId: 'p-1' },
          status: data.status ?? 'PENDING',
          claimedAt: data.claimedAt ?? null,
          createdAt: data.createdAt,
          retryCount: data.retryCount ?? 0,
          nextAttemptAt: data.nextAttemptAt ?? null,
          entityType: 'Product',
          entityId: 'p-1',
        },
      }),
    );
  const rowById = (id: string) => run.system(() => prisma.outboxEvent.findUniqueOrThrow({ where: { id } }));
  /** Product-family rows other suites left PENDING (the relay claims the oldest batch first): drain them until only rows in backoff remain. */
  const drainProductRelay = async () => {
    for (let i = 0; i < 200; i++) {
      const claimable = await run.system(() =>
        prisma.outboxEvent.count({
          where: {
            status: 'PENDING',
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
            AND: { OR: PRODUCT_RELAY_TYPE_PREFIXES.map((prefix) => ({ type: { startsWith: prefix } })) },
          },
        }),
      );
      if (claimable === 0) return;
      await productRelay.processOutbox();
    }
    throw new Error('product outbox did not drain');
  };

  beforeAll(async () => {
    app = await bootApp((b) => b.overrideProvider(OUTBOUND_RESOLVER).useValue(resolver).overrideProvider(WebhookHttpClient).useValue(http));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    reaper = app.get(OutboxReaperService);
    claims = app.get(OutboxClaimService);
    productRelay = app.get(OutboxProcessorWorker);
    config = app.get(EventsFeatureConfig);
    A = await createShop(app, 'obxA');
    B = await createShop(app, 'obxB');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('stale-claim reaper and backoff', () => {
    it('returns a stale claim to PENDING with backoff, fails one whose retries are spent, leaves a fresh claim alone', async () => {
      const now = new Date();
      const stale = await outboxRow(A, { status: 'CLAIMED', claimedAt: new Date(now.getTime() - config.outboxStaleClaimMs - HOUR_MS) });
      const legacy = await outboxRow(A, { status: 'PROCESSING', createdAt: new Date(now.getTime() - 2 * HOUR_MS), retryCount: config.outboxMaxRetries - 1 });
      const fresh = await outboxRow(A, { status: 'CLAIMED', claimedAt: now });

      const outcome = await run.system(() => reaper.reapStaleClaims(now));
      expect(outcome.retried).toBeGreaterThanOrEqual(1);
      expect(outcome.failed).toBeGreaterThanOrEqual(1);

      const retried = await rowById(stale.id);
      expect(retried).toMatchObject({ status: 'PENDING', retryCount: 1, claimedAt: null });
      expect(retried.nextAttemptAt!.getTime() - now.getTime()).toBe(claims.backoffMs(1));
      expect(await rowById(legacy.id)).toMatchObject({ status: 'FAILED', retryCount: config.outboxMaxRetries });
      expect(await rowById(fresh.id)).toMatchObject({ status: 'CLAIMED' });

      // Backoff is honoured: the relay skips the row until nextAttemptAt, then claims and settles it.
      await drainProductRelay();
      await productRelay.processOutbox();
      expect((await rowById(stale.id)).status).toBe('PENDING');
      await run.system(() => prisma.outboxEvent.update({ where: { id: stale.id }, data: { nextAttemptAt: new Date(now.getTime() - 1000) } }));
      await drainProductRelay();
      expect((await rowById(stale.id)).status).toBe('DONE');

      await run.system(() => prisma.outboxEvent.update({ where: { id: fresh.id }, data: { status: 'DONE' } }));
    });
  });

  describe('operator retry route', () => {
    it('resets only a FAILED row of the caller\'s shop, MANAGER+ only', async () => {
      const failed = await outboxRow(A, { status: 'FAILED', retryCount: 3, type: 'OrphanType' });
      const pending = await outboxRow(A, { status: 'DONE', type: 'OrphanType' });
      const foreign = await outboxRow(B, { status: 'FAILED', type: 'OrphanType' });
      const owner = await httpAs(app, A, ownerOf(A));
      const cashier = await httpAs(app, A, cashierOf(A));

      expect((await cashier.post('/api/sales/events/retry').send({ eventId: failed.id })).status).toBe(403);
      const notFailed = await owner.post('/api/sales/events/retry').send({ eventId: pending.id });
      expect(notFailed.status).toBe(409);
      expect(notFailed.body.code).toBe('OUTBOX_EVENT_NOT_FAILED');
      expect((await owner.post('/api/sales/events/retry').send({ eventId: foreign.id })).status).toBe(404);

      expect((await owner.post('/api/sales/events/retry').send({ eventId: failed.id })).status).toBe(201);
      expect(await rowById(failed.id)).toMatchObject({ status: 'PENDING', retryCount: 4, nextAttemptAt: null, claimedAt: null });
      expect((await owner.get(`/api/sales/events/${failed.id}`)).body.status).toBe('PENDING');
      expect((await owner.get(`/api/sales/events/${foreign.id}`)).status).toBe(404);
      expect((await owner.get('/api/sales/events?status=PENDING')).body.map((r: { id: string }) => r.id)).toContain(failed.id);

      await run.system(() => prisma.outboxEvent.updateMany({ where: { id: { in: [failed.id, foreign.id] } }, data: { status: 'DONE' } }));
    });
  });

  describe('webhook registration guard', () => {
    it('refuses http, credentials, literal private addresses and hosts that resolve privately; cashiers cannot register', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const cashier = await httpAs(app, A, cashierOf(A));
      const attempt = async (url: string) => {
        const res = await owner.post('/api/webhooks').send({ url, events: ['*'] });
        return { status: res.status, code: res.body.code };
      };
      expect(await attempt('http://hooks.example.test/in')).toEqual({ status: 400, code: 'WEBHOOK_URL_SCHEME' });
      expect(await attempt('https://user:pw@hooks.example.test/in')).toEqual({ status: 400, code: 'WEBHOOK_URL_CREDENTIALS' });
      expect(await attempt('https://10.0.0.1/in')).toEqual({ status: 400, code: 'WEBHOOK_URL_PRIVATE' });
      expect(await attempt('https://169.254.169.254/latest/meta-data/')).toEqual({ status: 400, code: 'WEBHOOK_URL_PRIVATE' });
      expect(await attempt('https://localhost:8080/in')).toEqual({ status: 400, code: 'WEBHOOK_URL_PRIVATE' });
      expect(await attempt('https://private.example.test/in')).toEqual({ status: 400, code: 'WEBHOOK_URL_PRIVATE' });
      expect((await cashier.post('/api/webhooks').send({ url: 'https://hooks.example.test/in', events: ['*'] })).status).toBe(403);
      expect(await run.system(() => prisma.webhookEndpoint.count({ where: { shopId: A.shopId } }))).toBe(0);
    });
  });

  describe('delivery', () => {
    const secret = 'integration-secret-0123456789';

    it('routes a claimed product event to the subscribed endpoint with a pinned address and a timestamped signature', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const created = await owner.post('/api/webhooks').send({ url: 'https://hooks.example.test/in', events: ['ProductCreated'], secret });
      expect(created.status).toBe(201);
      expect(created.body.secret).toBeUndefined(); // caller supplied it: never echoed
      const endpointId = created.body.id as string;

      const event = await outboxRow(A, { type: 'ProductCreated', payload: { productId: 'p-1', name: 'Tea' } });
      const other = await outboxRow(A, { type: 'InventoryAdjusted', payload: { productId: 'p-1' } }); // not subscribed
      await drainProductRelay();
      expect(await rowById(event.id)).toMatchObject({ status: 'DONE', error: null });
      expect((await rowById(other.id)).status).toBe('DONE');

      const delivery = await waitFor(() => run.system(() => prisma.webhookDelivery.findFirst({ where: { endpointId, eventId: event.id } })));
      expect(delivery).toMatchObject({ status: 'SUCCESS', statusCode: 200, eventType: 'ProductCreated' });
      expect(await run.system(() => prisma.webhookDelivery.count({ where: { endpointId } }))).toBe(1);

      const req = requests.find((r) => r.headers['x-dukanai-delivery'] !== undefined && JSON.parse(r.body).eventId === event.id);
      expect(req).toBeDefined();
      expect(req!.target.address).toBe(PUBLIC_IP);
      expect(req!.target.url.hostname).toBe('hooks.example.test');
      const ts = Number(req!.headers['x-dukanai-timestamp']);
      expect(Math.abs(Date.now() - ts)).toBeLessThan(60_000);
      expect(req!.headers['x-dukanai-signature']).toBe(signWebhookPayload(secret, ts, req!.body));
      expect(JSON.parse(req!.body)).toMatchObject({ eventId: event.id, eventType: 'ProductCreated', shopId: A.shopId, payload: { productId: 'p-1', name: 'Tea' } });

      const listed = await owner.get(`/api/webhooks/${endpointId}/deliveries`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect((await (await httpAs(app, B, ownerOf(B))).get(`/api/webhooks/${endpointId}/deliveries`)).status).toBe(404);
    });

    it('re-checks the address at send time: a host that now resolves privately is recorded FAILED and never contacted', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const created = await owner.post('/api/webhooks').send({ url: 'https://rebind.example.test/in', events: ['*'], secret });
      expect(created.status).toBe(201);
      dns.set('rebind.example.test', '169.254.169.254');
      try {
        const sent = http.post.mock.calls.length;
        const event = await outboxRow(A, { type: 'ProductUpdated', payload: { productId: 'p-2' } });
        await drainProductRelay();
        const delivery = await waitFor(() => run.system(() => prisma.webhookDelivery.findFirst({ where: { endpointId: created.body.id, eventId: event.id } })));
        expect(delivery.status).toBe('FAILED');
        expect(delivery.errorMessage).toContain('WEBHOOK_URL_PRIVATE');
        expect(http.post.mock.calls.length).toBe(sent);
      } finally {
        dns.delete('rebind.example.test');
      }
    });
  });
});

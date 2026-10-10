import { UnrecoverableError } from 'bullmq';
import * as crypto from 'crypto';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { OutboundUrlGuard } from '../../common/net/outbound-url-guard';
import { ProductWebhookDispatcherService, signWebhookPayload } from './webhook-dispatcher.service';
import { WebhookHttpClient, WebhookPostRequest } from './webhook-http-client';

describe('ProductWebhookDispatcherService (roadmap 4.8)', () => {
  const endpoint = { id: 'ep-1', shopId: 'shop-1', url: 'https://hooks.example.com/in', secret: 'super-secret-key-0123456789', events: ['*'], isActive: true };
  const event = { id: 'evt-1', type: 'ProductCreated', tenantId: null, shopId: 'shop-1', entityId: 'p-1', entityType: 'Product', createdAt: new Date('2026-09-29T00:00:00Z'), correlationId: 'corr-1', payload: { productId: 'p-1' } };

  let deliveries: unknown[];
  let requests: WebhookPostRequest[];
  let http: WebhookHttpClient;
  let prisma: { webhookEndpoint: { findUnique: jest.Mock }; outboxEvent: { findUnique: jest.Mock }; webhookDelivery: { create: jest.Mock } };
  let config: EventsFeatureConfig;

  const build = (guard: OutboundUrlGuard) => new ProductWebhookDispatcherService(prisma as never, config, guard, http);

  beforeEach(() => {
    deliveries = [];
    requests = [];
    config = new EventsFeatureConfig();
    prisma = {
      webhookEndpoint: { findUnique: jest.fn().mockResolvedValue(endpoint) },
      outboxEvent: { findUnique: jest.fn().mockResolvedValue(event) },
      webhookDelivery: { create: jest.fn().mockImplementation(async ({ data }) => deliveries.push(data)) },
    };
    http = { post: jest.fn().mockImplementation(async (req: WebhookPostRequest) => (requests.push(req), { status: 204 })) } as never;
  });

  it('signs the body with a timestamp, pins the vetted address, never follows redirects and records SUCCESS', async () => {
    const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }]);
    await build(guard).dispatch('ep-1', 'evt-1', null, 'job-7');

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.target.address).toBe('93.184.216.34');
    expect(req.target.url.hostname).toBe('hooks.example.com');
    expect(req.timeoutMs).toBe(config.webhookTimeoutMs);
    expect(req.maxResponseBytes).toBe(config.webhookMaxResponseBytes);
    expect(req.headers['x-dukanai-event']).toBe('ProductCreated');
    expect(req.headers['x-dukanai-delivery']).toBe('job-7');
    const ts = Number(req.headers['x-dukanai-timestamp']);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(5000);
    const expected = crypto.createHmac('sha256', endpoint.secret).update(`${ts}.${req.body}`).digest('hex');
    expect(req.headers['x-dukanai-signature']).toBe(`t=${ts},v1=${expected}`);
    expect(signWebhookPayload(endpoint.secret, ts, req.body)).toBe(req.headers['x-dukanai-signature']);
    expect(JSON.parse(req.body)).toMatchObject({ eventId: 'evt-1', eventType: 'ProductCreated', shopId: 'shop-1', payload: { productId: 'p-1' } });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ endpointId: 'ep-1', eventId: 'evt-1', status: 'SUCCESS', statusCode: 204 });
  });

  it('a private or unresolvable target is recorded FAILED and is not retried', async () => {
    const guard = new OutboundUrlGuard(async () => [{ address: '10.0.0.9', family: 4 }]);
    await expect(build(guard).dispatch('ep-1', 'evt-1', null)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(requests).toHaveLength(0);
    expect(deliveries[0]).toMatchObject({ status: 'FAILED', statusCode: null, errorMessage: expect.stringContaining('WEBHOOK_URL_PRIVATE') });
  });

  it('a non-2xx or unreachable endpoint is recorded FAILED with the status and retried by the queue', async () => {
    const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }]);
    (http.post as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    await expect(build(guard).dispatch('ep-1', 'evt-1', null)).rejects.toThrow(/Webhook Delivery Failed/);
    expect(deliveries[0]).toMatchObject({ status: 'FAILED', statusCode: 503 });
    const thrown = await build(guard).dispatch('ep-1', 'evt-1', null).catch((e) => e);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
  });

  it('skips a deleted or disabled endpoint without recording anything', async () => {
    prisma.webhookEndpoint.findUnique.mockResolvedValueOnce({ ...endpoint, isActive: false });
    const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }]);
    await build(guard).dispatch('ep-1', 'evt-1', null);
    expect(requests).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it('http targets are refused unless EVENTS_WEBHOOK_ALLOW_HTTP is on', async () => {
    prisma.webhookEndpoint.findUnique.mockResolvedValue({ ...endpoint, url: 'http://hooks.example.com/in' });
    const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(build(guard).dispatch('ep-1', 'evt-1', null)).rejects.toBeInstanceOf(UnrecoverableError);
    config.webhookAllowHttp = true;
    await build(guard).dispatch('ep-1', 'evt-1', null);
    expect(requests).toHaveLength(1);
  });
});

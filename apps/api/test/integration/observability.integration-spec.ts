/**
 * Observability (roadmap 7.6): the scrape endpoint and the application
 * metrics behind it, against the real AppModule. Boots with the HTTP metrics
 * middleware installed the way main.ts does it, so every answer (404s and
 * controller rejections included) is counted by route pattern and status.
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { BillingService } from '../../src/billing/billing.service';
import { httpMetricsMiddleware } from '../../src/common/observability/http-metrics.middleware';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ledgerPostingFailuresTotal } from '../../src/common/observability/metrics';
import { MonitoringConfig } from '../../src/config/domains/monitoring.config';
import { LedgerPostingService } from '../../src/ledger/ledger-posting.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { actorFor, bootApp, createProduct, createShop, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

const TOKEN = 'integration-scrape-token-0123456789';

/** The sample value of a metric line whose labels contain every given pair. */
function sample(text: string, metric: string, labels: Record<string, string>): number | undefined {
  const lines = text.split('\n').filter((line) => line.startsWith(`${metric}{`));
  const line = lines.find((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
  return line ? Number(line.slice(line.lastIndexOf('}') + 1).trim().split(' ')[0]) : undefined;
}

describe('observability: metrics endpoint and application metrics (roadmap 7.6)', () => {
  let app: INestApplication;
  let shop: TestShop;
  let productId: string;
  const monitoring = Object.assign(new MonitoringConfig(), {});
  const http = () => request(app.getHttpServer());
  const scrape = async (): Promise<string> => (await http().get('/api/metrics').expect(200)).text;

  beforeAll(async () => {
    app = await bootApp(
      (builder) => builder.overrideProvider(MonitoringConfig).useValue(monitoring),
      (nest) => nest.use(httpMetricsMiddleware),
    );
    shop = await createShop(app, 'obs');
    productId = await createProduct(app, shop, { key: 'OBS' });
    await receiveStock(app, shop, productId, 50);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/metrics needs no login and answers the Prometheus text format, uncached', async () => {
    const res = await http().get('/api/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE checkout_duration_seconds histogram');
    expect(res.text).toContain('# TYPE ledger_posting_failures_total counter');
    expect(res.text).toContain('dukaanai_process_cpu_seconds_total');
    expect(res.text).toMatch(/service="dukaanai-api"/);
  });

  it('counts every HTTP answer by route pattern and status, 404s under one label', async () => {
    await http().get('/api/health/live').expect(200);
    await http().get('/api/no-such-route').expect(404);
    await http().get('/api/another/unknown/path').expect(404);

    const text = await scrape();
    expect(sample(text, 'http_requests_total', { method: 'GET', route: '/api/health/live', status: '200' })).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'http_requests_total', { method: 'GET', route: 'unmatched', status: '404' })).toBeGreaterThanOrEqual(2);
    expect(sample(text, 'http_request_duration_seconds_count', { method: 'GET', route: '/api/health/live' })).toBeGreaterThanOrEqual(1);
    // No raw path ever becomes a label.
    expect(text).not.toContain('no-such-route');
  });

  it('observes checkout latency by outcome: completed, replayed, rejected', async () => {
    const billing = app.get(BillingService);
    const run = tenantRunner(app);
    const actor = actorFor(shop, shop.cashierId, Role.CASHIER);
    const key = randomUUID();
    const dto = { idempotencyKey: key, items: [{ productId, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 236 }] };

    const before = await scrape();
    const completedBefore = sample(before, 'checkout_duration_seconds_count', { outcome: 'completed' }) ?? 0;

    await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => billing.createInvoice(dto, actor));
    const replay = await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => billing.createInvoice(dto, actor));
    expect(replay.replayed).toBe(true);
    await expect(
      run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
        billing.createInvoice({ ...dto, idempotencyKey: randomUUID(), items: [{ productId: 'no-such-product', quantity: 1 }] }, actor),
      ),
    ).rejects.toBeDefined();

    const text = await scrape();
    expect(sample(text, 'checkout_duration_seconds_count', { outcome: 'completed' })).toBe(completedBefore + 1);
    expect(sample(text, 'checkout_duration_seconds_count', { outcome: 'replayed' })).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'checkout_duration_seconds_count', { outcome: 'rejected' })).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'checkout_duration_seconds_bucket', { outcome: 'completed', le: '+Inf' })).toBe(completedBefore + 1);
  });

  it('reads outbox depth and lag from the database and queue depth from BullMQ on every scrape', async () => {
    // The sale above staged an outbox row; with CRON_ENABLED=false no relay claims it.
    const prisma = app.get(PrismaService);
    const pending = await tenantRunner(app).system(() => prisma.outboxEvent.count({ where: { status: 'PENDING' } }));
    expect(pending).toBeGreaterThanOrEqual(1);

    const text = await scrape();
    expect(sample(text, 'outbox_rows', { status: 'PENDING' })).toBe(pending);
    expect(sample(text, 'outbox_rows', { status: 'FAILED' })).toBeGreaterThanOrEqual(0);
    const lag = Number(/^outbox_oldest_pending_age_seconds(?:\{[^}]*\})? (\S+)/m.exec(text)?.[1]);
    expect(lag).toBeGreaterThanOrEqual(0);
    for (const queue of ['system-events', 'webhook-delivery']) {
      for (const state of ['waiting', 'active', 'delayed', 'failed']) {
        expect(sample(text, 'queue_jobs', { queue, state })).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('counts a ledger posting that throws, by source type', async () => {
    const ledger = app.get(LedgerPostingService);
    const prisma = app.get(PrismaService);
    const unbalanced = {
      shopId: shop.shopId,
      source: { type: 'SALE' as const, id: `obs-${randomUUID()}` },
      description: 'unbalanced on purpose',
      entries: [
        { account: 'CASH' as const, type: 'DEBIT' as const, amount: '10.00' },
        { account: 'SALES_REVENUE' as const, type: 'CREDIT' as const, amount: '9.00' },
      ],
    };
    const before = (await ledgerPostingFailuresTotal.get()).values.find((v) => v.labels.source === 'SALE')?.value ?? 0;
    await expect(tenantRunner(app).system(() => ledger.post(prisma, unbalanced))).rejects.toThrow(/Unbalanced ledger posting/);
    expect(sample(await scrape(), 'ledger_posting_failures_total', { source: 'SALE' })).toBe(before + 1);
  });

  it('turns the backup status files into backup_last_success_timestamp_seconds{kind} on every scrape (roadmap 9.4)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-status-'));
    try {
      await fs.writeFile(path.join(dir, 'dump.last-success'), '2026-10-05T02:00:07Z\n/backups/x.sql.gz\n');
      Object.assign(monitoring, { backupStatusDir: dir });
      expect(sample(await scrape(), 'backup_last_success_timestamp_seconds', { kind: 'dump' })).toBe(Date.parse('2026-10-05T02:00:07Z') / 1000);
      await fs.writeFile(path.join(dir, 'offsite.last-success'), '2026-10-05T03:10:00Z\n');
      const text = await scrape();
      expect(sample(text, 'backup_last_success_timestamp_seconds', { kind: 'offsite' })).toBe(Date.parse('2026-10-05T03:10:00Z') / 1000);
      expect(sample(text, 'backup_last_success_timestamp_seconds', { kind: 'dump' })).toBe(Date.parse('2026-10-05T02:00:07Z') / 1000);
    } finally {
      Object.assign(monitoring, { backupStatusDir: undefined });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('requires the bearer token once METRICS_TOKEN is set and answers 404 when metrics are disabled', async () => {
    Object.assign(monitoring, { metricsToken: TOKEN });
    try {
      await http().get('/api/metrics').expect(401);
      await http().get('/api/metrics').set('Authorization', `Bearer ${TOKEN}x`).expect(401);
      const ok = await http().get('/api/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
      // The refused scrapes were counted like any other answer.
      expect(sample(ok.text, 'http_requests_total', { route: '/api/metrics', status: '401' })).toBeGreaterThanOrEqual(2);
    } finally {
      Object.assign(monitoring, { metricsToken: undefined });
    }

    Object.assign(monitoring, { metricsEnabled: false });
    try {
      await http().get('/api/metrics').expect(404);
    } finally {
      Object.assign(monitoring, { metricsEnabled: true });
    }
    await http().get('/api/metrics').expect(200);
  });
});

/**
 * Retention sweep (roadmap 7.8) against the real database: only rows no flow
 * reads any more are removed, each table is reported, a run is bounded by its
 * batch budget and continues on the next run, the sweep runs under the
 * cluster lock, and the purge indexes the migration added exist.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CronLockService } from '../../src/common/cron-lock/cron-lock.service';
import { retentionRowsPurgedTotal } from '../../src/common/observability/metrics';
import { RetentionSweepService } from '../../src/common/retention/retention-sweep.service';
import { RetentionConfig } from '../../src/config/domains/retention.config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';

const DAY = 86_400_000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY);
const daysAhead = (now: Date, days: number) => new Date(now.getTime() + days * DAY);

describe('retention sweep (roadmap 7.8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: RetentionSweepService;
  let shop: TestShop;
  let run: ReturnType<typeof tenantRunner>;
  const retention = Object.assign(new RetentionConfig(), {});

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(RetentionConfig).useValue(retention));
    prisma = app.get(PrismaService);
    service = app.get(RetentionSweepService);
    run = tenantRunner(app);
    shop = await createShop(app, 'ret', { resolveLocation: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the columns the sweep deletes by are indexed (migration 20261003090000_retention_indexes)', async () => {
    const expected = ['ProductEventLog_timestamp_idx', 'RefreshToken_expiresAt_idx', 'SearchHistory_createdAt_idx'];
    const rows = await run.system(
      () => prisma.$queryRaw<Array<{ INDEX_NAME: string }>>`
        SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('RefreshToken_expiresAt_idx', 'SearchHistory_createdAt_idx', 'ProductEventLog_timestamp_idx')
      `,
    );
    expect(rows.map((r) => r.INDEX_NAME).sort()).toEqual(expected);
  });

  it('removes only what no flow reads any more and reports every table', async () => {
    const now = new Date();
    const { ownerId, shopId } = shop;
    const seeded = await run.system(async () => {
      const token = (expiresAt: Date, extra: { isRevoked?: boolean; rotatedAt?: Date } = {}) =>
        prisma.refreshToken.create({
          data: { token: randomUUID(), userId: ownerId, familyId: randomUUID(), expiresAt, absoluteExpiresAt: daysAhead(expiresAt, 23), ...extra },
          select: { id: true },
        });
      const reset = (expiresAt: Date, usedAt: Date | null) =>
        prisma.passwordResetToken.create({ data: { userId: ownerId, tokenHash: randomUUID(), expiresAt, usedAt }, select: { id: true } });
      const outbox = (status: string, createdAt: Date) =>
        prisma.outboxEvent.create({
          data: { shopId, type: 'RetentionProbe', payload: {}, status, createdAt, processedAt: status === 'PENDING' ? null : createdAt },
          select: { id: true },
        });
      const search = (createdAt: Date) =>
        prisma.searchHistory.create({ data: { shopId, query: 'retention probe', resultCount: 0, durationMs: 1, createdAt }, select: { id: true } });
      const event = (timestamp: Date) =>
        prisma.productEventLog.create({ data: { shopId, eventId: randomUUID(), eventType: 'RetentionProbe', payload: {}, timestamp }, select: { id: true } });

      return {
        purge: {
          refreshExpiredLongAgo: await token(daysAgo(now, 30)),
          refreshConsumedLongAgo: await token(daysAgo(now, 30), { isRevoked: true, rotatedAt: daysAgo(now, 31) }),
          resetUsedLongAgo: await reset(daysAgo(now, 30), daysAgo(now, 30)),
          resetExpiredUnused: await reset(daysAgo(now, 30), null),
          outboxDoneOld: await outbox('DONE', daysAgo(now, 30)),
          searchOld: await search(daysAgo(now, 120)),
          eventOld: await event(daysAgo(now, 200)),
        },
        keep: {
          refreshLive: await token(daysAhead(now, 5)),
          refreshExpiredWithinGrace: await token(daysAgo(now, 3)),
          refreshConsumedWithinGrace: await token(daysAgo(now, 3), { isRevoked: true, rotatedAt: daysAgo(now, 5) }),
          resetFresh: await reset(daysAhead(now, 0.04), null),
          resetUsedToday: await reset(daysAgo(now, 0.01), now),
          outboxDoneRecent: await outbox('DONE', daysAgo(now, 1)),
          outboxFailedOld: await outbox('FAILED', daysAgo(now, 30)),
          outboxPendingOld: await outbox('PENDING', daysAgo(now, 30)),
          searchRecent: await search(daysAgo(now, 3)),
          eventRecent: await event(daysAgo(now, 10)),
        },
      };
    });

    const outcome = await service.purgeExpired(now);
    expect(outcome.truncated).toEqual([]);
    expect(outcome.purged.RefreshToken).toBeGreaterThanOrEqual(2);
    expect(outcome.purged.PasswordResetToken).toBeGreaterThanOrEqual(2);
    expect(outcome.purged.OutboxEvent).toBeGreaterThanOrEqual(1);
    expect(outcome.purged.SearchHistory).toBeGreaterThanOrEqual(1);
    expect(outcome.purged.ProductEventLog).toBeGreaterThanOrEqual(1);

    const exists = {
      refresh: (id: string) => prisma.refreshToken.findUnique({ where: { id }, select: { id: true } }),
      reset: (id: string) => prisma.passwordResetToken.findUnique({ where: { id }, select: { id: true } }),
      outbox: (id: string) => prisma.outboxEvent.findUnique({ where: { id }, select: { id: true } }),
      search: (id: string) => prisma.searchHistory.findUnique({ where: { id }, select: { id: true } }),
      event: (id: string) => prisma.productEventLog.findUnique({ where: { id }, select: { id: true } }),
    };
    const kindOf = (name: string) => (name.startsWith('refresh') ? 'refresh' : name.startsWith('reset') ? 'reset' : name.startsWith('outbox') ? 'outbox' : name.startsWith('search') ? 'search' : 'event');
    await run.system(async () => {
      for (const [name, row] of Object.entries(seeded.purge)) {
        expect({ name, row: await exists[kindOf(name)](row.id) }).toEqual({ name, row: null });
      }
      for (const [name, row] of Object.entries(seeded.keep)) {
        expect({ name, row: await exists[kindOf(name)](row.id) }).toEqual({ name, row: { id: row.id } });
      }
    });

    // The purge is idempotent: a second run over the same instant finds nothing of ours.
    const again = await service.purgeExpired(now);
    expect(Object.values(again.purged).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('bounds a run by the batch budget and continues on the next run', async () => {
    const now = new Date();
    const marker = `retention batch ${randomUUID()}`;
    await run.system(() =>
      prisma.searchHistory.createMany({
        data: Array.from({ length: 150 }, () => ({ shopId: shop.shopId, query: marker, resultCount: 0, durationMs: 1, createdAt: daysAgo(now, 400) })),
      }),
    );
    const remaining = () => run.system(() => prisma.searchHistory.count({ where: { shopId: shop.shopId, query: marker } }));

    Object.assign(retention, { batchSize: 100, maxBatchesPerRun: 1 });
    try {
      const first = await service.purgeExpired(now);
      expect(first.purged.SearchHistory).toBe(100);
      expect(first.truncated).toEqual(['SearchHistory']);
      expect(await remaining()).toBe(50);

      const second = await service.purgeExpired(now);
      expect(second.purged.SearchHistory).toBe(50);
      expect(second.truncated).toEqual([]);
      expect(await remaining()).toBe(0);
    } finally {
      Object.assign(retention, { batchSize: 1000, maxBatchesPerRun: 200 });
    }
  });

  it('runs under the cluster lock: while another holder has it, the sweep is skipped', async () => {
    const lock = app.get(CronLockService);
    const whileHeld = await lock.withLock('cron:retention-sweep', 10_000, () => service.sweep());
    expect(whileHeld).toBeNull();

    const outcome = await service.sweep();
    expect(outcome).not.toBeNull();
    expect(outcome!.truncated).toEqual([]);
  });

  it('counts every purged row in retention_rows_purged_total by table', async () => {
    const values = (await retentionRowsPurgedTotal.get()).values;
    const value = (table: string) => values.find((v) => v.labels.table === table)?.value ?? 0;
    expect(value('SearchHistory')).toBeGreaterThanOrEqual(151);
    expect(value('RefreshToken')).toBeGreaterThanOrEqual(2);
    expect(value('OutboxEvent')).toBeGreaterThanOrEqual(1);
    expect(value('ProductEventLog')).toBeGreaterThanOrEqual(1);
    expect(value('PasswordResetToken')).toBeGreaterThanOrEqual(2);
  });
});

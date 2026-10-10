import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { promises as fs } from 'fs';
import type Redis from 'ioredis';
import * as path from 'path';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { StorageConfig } from '../../config/domains/storage.config';
import { UploadConfig } from '../../config/domains/upload.config';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { queueInstances } from '../lifecycle/queue-readiness';
import {
  backupLastSuccessTimestampSeconds,
  buildInfo,
  dependencyUp,
  outboxOldestPendingAgeSeconds,
  outboxRows,
  queueJobs,
  queuePaused,
  reconciliationLastRunTimestampSeconds,
  reconciliationShopsWithDrift,
  storageVolumeFreeBytes,
  storageVolumeSizeBytes,
} from './metrics';

const OUTBOX_STATUSES = ['PENDING', 'CLAIMED', 'PROCESSING', 'DONE', 'FAILED'] as const;
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Each source must answer within this, or its gauges keep their previous
 * values for this scrape (roadmap 9.18): Prometheus' scrape timeout is 10 s,
 * and a scrape that hangs on one dead dependency reads as "API down".
 */
export const COLLECTOR_BUDGET_MS = 2_500;
/** A dependency probe that has not answered within this counts the dependency down (the readiness probe uses the same 2 s). */
export const DEPENDENCY_PROBE_MS = 2_000;

/** `<kind>.last-success`: the kind is lower-case letters only (dump, binlog, documents, offsite). */
const STATUS_FILE = /^([a-z]+)\.last-success$/;

/**
 * Gauges that are read, not counted (roadmap 7.6): outbox lag and depth from
 * the database, queue depth from BullMQ, and the backup jobs' last success
 * from the status files (roadmap 9.4), the reachability of the database and
 * Redis and the free space of the volumes the API writes to (roadmap 9.18).
 * Refreshed on every scrape by `MetricsController`. The dependencies are
 * probed first; a source that needs a dependency that is down is skipped, and
 * every source is bounded by COLLECTOR_BUDGET_MS, so a Redis or database
 * outage leaves the other figures current and the scrape itself answering
 * (the first Redis drill found BullMQ's job counts waiting for Redis forever,
 * the scrape timing out and DukaanAiApiDown paging for an API that was
 * selling).
 */
@Injectable()
export class ObservabilityCollectorsService {
  private readonly logger = new Logger(ObservabilityCollectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly modules: ModulesContainer,
    private readonly monitoring: MonitoringConfig,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
    @Optional() private readonly storageConfig?: StorageConfig,
    @Optional() private readonly uploadConfig?: UploadConfig,
  ) {
    // The release never changes in a running process: one series, set once.
    buildInfo.reset();
    buildInfo.labels({ release: monitoring.appRelease || 'unknown' }).set(1);
  }

  async refresh(): Promise<void> {
    const deps = await this.refreshDependencies();
    await Promise.all([
      this.bounded('backup status', this.refreshBackupStatus()),
      this.bounded('storage volumes', this.refreshStorageVolumes()),
      deps.database ? this.bounded('outbox', this.refreshOutbox()) : Promise.resolve(),
      deps.database ? this.bounded('reconciliation', this.refreshReconciliation()) : Promise.resolve(),
      deps.redis ? this.bounded('queues', this.refreshQueues()) : this.skipQueues(),
    ]);
  }

  /** Resolves when the work settles or the budget runs out, whichever is first; never rejects. */
  private async bounded(source: string, work: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), COLLECTOR_BUDGET_MS);
    });
    try {
      const outcome = await Promise.race([work.then(() => 'done' as const), late]);
      if (outcome === 'late') this.logger.warn(`${source} metrics not refreshed within ${COLLECTOR_BUDGET_MS} ms; the previous values stay`);
    } catch (error) {
      this.logger.warn(`${source} metrics not refreshed: ${(error as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async probe(check: () => Promise<unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), DEPENDENCY_PROBE_MS);
    });
    try {
      await Promise.race([check(), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `dependency_up{dependency}`: SELECT 1 on the database, PING on the shared Redis client. */
  async refreshDependencies(): Promise<{ database: boolean; redis: boolean }> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.redis ? this.probe(() => this.redis!.ping()) : Promise.resolve(true),
    ]);
    dependencyUp.set({ dependency: 'database' }, database ? 1 : 0);
    if (this.redis) dependencyUp.set({ dependency: 'redis' }, redis ? 1 : 0);
    return { database, redis };
  }

  /**
   * Redis is down: BullMQ's counts would wait for it (its connections retry
   * forever), so the queue series are dropped for this scrape rather than
   * reported stale; the backlog alerts resume when Redis is back.
   */
  private async skipQueues(): Promise<void> {
    queueJobs.reset();
    queuePaused.reset();
  }

  /**
   * Free and total bytes of the volume under the storage root and under the
   * upload temp directory (statfs: what an unprivileged writer may use).
   * A path that does not exist yet is measured at its nearest existing parent.
   */
  async refreshStorageVolumes(): Promise<void> {
    const volumes: Array<[string, string | undefined]> = [
      ['storage', this.storageConfig ? path.resolve(this.storageConfig.storageRoot || path.join(process.cwd(), 'data', 'storage')) : undefined],
      ['uploads', this.uploadConfig ? path.resolve(this.uploadConfig.tempDir) : undefined],
    ];
    for (const [volume, dir] of volumes) {
      if (!dir) continue;
      try {
        const stats = await fs.statfs(await nearestExisting(dir));
        storageVolumeFreeBytes.set({ volume }, Number(stats.bavail) * Number(stats.bsize));
        storageVolumeSizeBytes.set({ volume }, Number(stats.blocks) * Number(stats.bsize));
      } catch (error) {
        this.logger.warn(`Storage volume ${volume} not measured: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The latest reconciliation run of every shop (roadmap 9.5): how many shops
   * are not clean, and when the most recent run finished. Read from the
   * database so the figures survive a restart and do not depend on which
   * instance ran the cron; a shop that has never been reconciled has no run
   * and does not count, and the timestamp gauge has no series until one has.
   */
  async refreshReconciliation(): Promise<void> {
    try {
      const rows = await this.tenantContext.runAsSuperAdmin(
        async () =>
          await this.prisma.$queryRaw<Array<{ notClean: unknown; lastFinished: Date | null }>>`
            SELECT
              COALESCE(SUM(CASE WHEN r.status <> 'CLEAN' THEN 1 ELSE 0 END), 0) AS notClean,
              MAX(r.finishedAt) AS lastFinished
            FROM ReconciliationRun r
            JOIN (SELECT shopId, MAX(startedAt) AS startedAt FROM ReconciliationRun GROUP BY shopId) latest
              ON latest.shopId = r.shopId AND latest.startedAt = r.startedAt
          `,
      );
      const row = rows[0];
      reconciliationShopsWithDrift.set(Number(row?.notClean ?? 0));
      const finished = row?.lastFinished ? new Date(row.lastFinished).getTime() : NaN;
      if (Number.isFinite(finished)) reconciliationLastRunTimestampSeconds.set(Math.floor(finished / 1000));
    } catch (error) {
      this.logger.warn(`Reconciliation gauges not refreshed: ${(error as Error).message}`);
    }
  }

  /**
   * One series per `<kind>.last-success` file in `BACKUP_STATUS_DIR`, valued
   * with the UTC time on its first line. The gauge is cleared before the
   * files are read, so a kind whose file disappears loses its series (and the
   * "never recorded" alert fires) instead of reporting a stale success
   * forever; an unreadable directory keeps the previous values and logs.
   */
  async refreshBackupStatus(): Promise<void> {
    const dir = this.monitoring.backupStatusDir?.trim();
    if (!dir) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      this.logger.warn(`Backup status not refreshed: cannot read ${dir}: ${(error as Error).message}`);
      return;
    }
    const found: Array<{ kind: string; seconds: number }> = [];
    for (const name of names) {
      const match = STATUS_FILE.exec(name);
      if (!match) continue;
      const kind = match[1];
      try {
        const firstLine = (await fs.readFile(path.join(dir, name), 'utf8')).split('\n')[0]?.trim() ?? '';
        const millis = Date.parse(firstLine);
        if (!Number.isFinite(millis)) {
          this.logger.warn(`Backup status ${name} has no readable time on its first line ("${firstLine.slice(0, 40)}")`);
          continue;
        }
        found.push({ kind, seconds: Math.floor(millis / 1000) });
      } catch (error) {
        this.logger.warn(`Backup status ${name} not read: ${(error as Error).message}`);
      }
    }
    backupLastSuccessTimestampSeconds.reset();
    for (const { kind, seconds } of found) backupLastSuccessTimestampSeconds.set({ kind }, seconds);
  }

  /** Outbox rows by status and the age of the oldest row still waiting (PENDING or CLAIMED). */
  async refreshOutbox(now: Date = new Date()): Promise<void> {
    try {
      const rows = await this.tenantContext.runAsSuperAdmin(async () => {
        const counts = await this.prisma.$queryRaw<Array<{ status: string; n: bigint | number }>>`
          SELECT status, COUNT(*) AS n FROM OutboxEvent GROUP BY status
        `;
        const oldest = await this.prisma.$queryRaw<Array<{ createdAt: Date | null }>>`
          SELECT MIN(createdAt) AS createdAt FROM OutboxEvent WHERE status IN ('PENDING', 'CLAIMED', 'PROCESSING')
        `;
        return { counts, oldest: oldest[0]?.createdAt ?? null };
      });
      const byStatus = new Map(rows.counts.map((r) => [r.status, Number(r.n)]));
      for (const status of OUTBOX_STATUSES) outboxRows.set({ status }, byStatus.get(status) ?? 0);
      outboxOldestPendingAgeSeconds.set(rows.oldest ? Math.max(0, (now.getTime() - new Date(rows.oldest).getTime()) / 1000) : 0);
    } catch (error) {
      this.logger.warn(`Outbox metrics not refreshed: ${(error as Error).message}`);
    }
  }

  /**
   * Job counts per BullMQ queue, from the queue clients already open in this
   * process. A paused queue keeps its jobs in BullMQ's `paused` list, which
   * `getJobCounts` reports apart from `waiting`: they wait all the same, so
   * they count as waiting, and `queue_paused` says why nothing takes them
   * (a paused queue read 0 waiting and never raised DukaanAiQueueBacklog,
   * found walking it, roadmap 9.22).
   */
  async refreshQueues(): Promise<void> {
    const { queues } = queueInstances(this.modules);
    await Promise.all(
      queues.map(async (queue) => {
        try {
          const client = queue as unknown as { getJobCounts(...states: string[]): Promise<Record<string, number>>; isPaused(): Promise<boolean> };
          const [counts, paused] = await Promise.all([client.getJobCounts(...QUEUE_STATES), client.isPaused()]);
          for (const state of QUEUE_STATES) queueJobs.set({ queue: queue.name, state }, (counts[state] ?? 0) + (state === 'waiting' ? (counts.paused ?? 0) : 0));
          queuePaused.set({ queue: queue.name }, paused ? 1 : 0);
        } catch (error) {
          this.logger.warn(`Queue metrics for ${queue.name} not refreshed: ${(error as Error).message}`);
        }
      }),
    );
  }
}

/** The directory itself, or the closest ancestor that exists (statfs needs an existing path). */
async function nearestExisting(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

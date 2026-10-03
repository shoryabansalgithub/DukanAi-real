import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../prisma/prisma.service';
import { CronConfig } from '../../config/domains/cron.config';
import { RetentionConfig } from '../../config/domains/retention.config';
import { CronLockService } from '../cron-lock/cron-lock.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { retentionRowsPurgedTotal } from '../observability/metrics';

/** Longer than any run should take: 200 batches x 5 tables of indexed deletes finish in minutes. */
const LOCK_TTL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export const RETENTION_TABLES = ['RefreshToken', 'PasswordResetToken', 'OutboxEvent', 'SearchHistory', 'ProductEventLog'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

export interface RetentionOutcome {
  purged: Record<RetentionTable, number>;
  /** Tables whose batch budget ran out before the backlog was drained; the next run continues. */
  truncated: RetentionTable[];
  durationMs: number;
}

/**
 * Retention sweep (roadmap 7.8). Once a night, under a cluster-wide lock,
 * deletes the rows no flow reads any more (`RetentionConfig` says how old):
 * expired refresh tokens and used / expired password-reset tokens, DONE
 * outbox rows, old SearchHistory and ProductEventLog rows. Every statement is
 * a bounded `DELETE ... LIMIT` on an index of the column it filters by
 * (`RefreshToken(expiresAt)`, `OutboxEvent(status, createdAt)`,
 * `SearchHistory(createdAt)`, `ProductEventLog(timestamp)`), so a sweep never
 * scans a table or holds a lock across a large range. FAILED outbox rows,
 * live tokens and everything newer than its window are never touched.
 */
@Injectable()
export class RetentionSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retention: RetentionConfig,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cronLock: CronLockService,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cronConfig.enabled) {
      this.logger.warn('RetentionSweep schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.retentionSweepCron, () => {
      void this.sweep().catch((error: unknown) => this.logger.error(`Retention sweep crashed: ${(error as Error).message}`));
    });
    this.schedulerRegistry.addCronJob('RetentionSweep', job);
    job.start();
  }

  /** One sweep under the cluster lock; `null` when another instance holds it. */
  sweep(now: Date = new Date()): Promise<RetentionOutcome | null> {
    return this.cronLock.withLock('cron:retention-sweep', LOCK_TTL_MS, () => this.tenantContext.runAsSuperAdmin(() => this.purgeExpired(now)));
  }

  /** The sweep itself (no lock): every table in turn, in batches, each table bounded by the run's batch budget. */
  async purgeExpired(now: Date = new Date()): Promise<RetentionOutcome> {
    const started = Date.now();
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const tokensBefore = before(this.retention.expiredTokensDays);
    const outboxBefore = before(this.retention.outboxDoneDays);
    const searchBefore = before(this.retention.searchHistoryDays);
    const eventsBefore = before(this.retention.productEventLogDays);

    const steps: Record<RetentionTable, (limit: number) => Promise<number>> = {
      RefreshToken: (limit) => this.prisma.$executeRaw`DELETE FROM RefreshToken WHERE expiresAt < ${tokensBefore} LIMIT ${limit}`,
      PasswordResetToken: (limit) =>
        this.prisma.$executeRaw`DELETE FROM PasswordResetToken WHERE expiresAt < ${tokensBefore} OR usedAt < ${tokensBefore} LIMIT ${limit}`,
      OutboxEvent: (limit) => this.prisma.$executeRaw`DELETE FROM OutboxEvent WHERE status = 'DONE' AND createdAt < ${outboxBefore} LIMIT ${limit}`,
      SearchHistory: (limit) => this.prisma.$executeRaw`DELETE FROM SearchHistory WHERE createdAt < ${searchBefore} LIMIT ${limit}`,
      ProductEventLog: (limit) => this.prisma.$executeRaw`DELETE FROM ProductEventLog WHERE timestamp < ${eventsBefore} LIMIT ${limit}`,
    };

    const outcome: RetentionOutcome = {
      purged: { RefreshToken: 0, PasswordResetToken: 0, OutboxEvent: 0, SearchHistory: 0, ProductEventLog: 0 },
      truncated: [],
      durationMs: 0,
    };
    for (const table of RETENTION_TABLES) {
      for (let batch = 1; ; batch++) {
        const deleted = await steps[table](this.retention.batchSize);
        if (deleted > 0) {
          outcome.purged[table] += deleted;
          retentionRowsPurgedTotal.inc({ table }, deleted);
        }
        if (deleted < this.retention.batchSize) break;
        if (batch >= this.retention.maxBatchesPerRun) {
          outcome.truncated.push(table);
          break;
        }
      }
    }
    outcome.durationMs = Date.now() - started;

    const total = Object.values(outcome.purged).reduce((a, b) => a + b, 0);
    if (total > 0 || outcome.truncated.length > 0) {
      const perTable = RETENTION_TABLES.map((t) => `${t}=${outcome.purged[t]}`).join(' ');
      const carry = outcome.truncated.length > 0 ? `; batch budget exhausted for ${outcome.truncated.join(', ')}, the next run continues` : '';
      this.logger.log(`Retention sweep: ${total} row(s) purged (${perTable}) in ${outcome.durationMs} ms${carry}`);
    }
    return outcome;
  }
}

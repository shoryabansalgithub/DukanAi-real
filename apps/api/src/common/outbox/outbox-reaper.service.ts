import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CronConfig } from '../../config/domains/cron.config';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { CronLockService } from '../cron-lock/cron-lock.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { OutboxClaimService } from './outbox-claim.service';

const LOCK_TTL_MS = 60_000;
const REAP_BATCH = 500;
/** Batches per sweep: bounds one tick after an outage left a large backlog; the next tick continues. */
const MAX_BATCHES_PER_SWEEP = 20;

export interface ReapOutcome {
  retried: number;
  failed: number;
}

/**
 * Stale-claim reaper (roadmap 4.7). A relay that crashed after claiming, a
 * worker that died mid-job or a Redis outage after the claim committed all
 * leave rows CLAIMED (or, before 4.7, PROCESSING) forever, because no relay
 * re-selects them. Every tick, under a cluster-wide lock, claims older than
 * `EVENTS_OUTBOX_STALE_CLAIM_MS` go back to PENDING with the same exponential
 * backoff a failed attempt gets, or to FAILED once the retries are spent.
 */
@Injectable()
export class OutboxReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxReaperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: OutboxClaimService,
    private readonly eventsConfig: EventsFeatureConfig,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cronLock: CronLockService,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cronConfig.enabled) {
      this.logger.warn('OutboxReaper schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.outboxReaperCron, () => {
      void this.reap().catch((error: unknown) => this.logger.error(`Outbox reaper crashed: ${(error as Error).message}`));
    });
    this.schedulerRegistry.addCronJob('OutboxReaper', job);
    job.start();
  }

  /** Runs one sweep under the cluster lock; `null` when another pod holds it. */
  reap(): Promise<ReapOutcome | null> {
    return this.cronLock.withLock('cron:outbox-reaper', LOCK_TTL_MS, () => this.tenantContext.runAsSuperAdmin(() => this.reapStaleClaims()));
  }

  /** The sweep itself (no lock): every stale claim back to PENDING with backoff, or FAILED, in batches. */
  async reapStaleClaims(now: Date = new Date()): Promise<ReapOutcome> {
    const outcome: ReapOutcome = { retried: 0, failed: 0 };
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
      const handled = await this.reapBatch(now, outcome);
      if (handled < REAP_BATCH) break;
    }
    if (outcome.retried > 0 || outcome.failed > 0) {
      this.logger.warn(`Outbox reaper: ${outcome.retried} stale claim(s) back to PENDING, ${outcome.failed} FAILED.`);
    }
    return outcome;
  }

  /** One batch of the oldest stale claims; returns how many rows it looked at. */
  private async reapBatch(now: Date, outcome: ReapOutcome): Promise<number> {
    const staleBefore = new Date(now.getTime() - this.eventsConfig.outboxStaleClaimMs);

    // Rows claimed before 4.7 carry no claimedAt: their createdAt stands in.
    const stale = await this.prisma.$queryRaw<Array<{ id: string; retryCount: number; status: string }>>`
      SELECT id, retryCount, status
      FROM OutboxEvent
      WHERE status IN ('CLAIMED', 'PROCESSING')
        AND COALESCE(claimedAt, createdAt) < ${staleBefore}
      ORDER BY createdAt ASC
      LIMIT ${REAP_BATCH}
    `;
    if (stale.length === 0) return 0;

    const exhausted = stale.filter((r) => r.retryCount + 1 >= this.eventsConfig.outboxMaxRetries).map((r) => r.id);
    if (exhausted.length > 0) {
      outcome.failed += await this.prisma.$executeRaw`
        UPDATE OutboxEvent
        SET status = 'FAILED', error = 'stale claim: no worker finished it', retryCount = retryCount + 1, processedAt = ${now}
        WHERE id IN (${Prisma.join(exhausted)}) AND status IN ('CLAIMED', 'PROCESSING')
      `;
    }
    for (const row of stale) {
      if (exhausted.includes(row.id)) continue;
      const attempt = row.retryCount + 1;
      const nextAttemptAt = new Date(now.getTime() + this.claims.backoffMs(attempt));
      outcome.retried += await this.prisma.$executeRaw`
        UPDATE OutboxEvent
        SET status = 'PENDING', claimedAt = NULL, retryCount = ${attempt}, nextAttemptAt = ${nextAttemptAt}, error = 'stale claim: no worker finished it'
        WHERE id = ${row.id} AND status IN ('CLAIMED', 'PROCESSING')
      `;
    }
    return stale.length;
  }
}

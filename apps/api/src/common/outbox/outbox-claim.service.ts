import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';

/** The columns every relay needs to build its job. */
export interface ClaimedOutboxRow {
  id: string;
  shopId: string;
  tenantId: string | null;
  type: string;
  payload: unknown;
  correlationId: string | null;
  actorId: string | null;
  entityId: string | null;
  retryCount: number;
}

/** OutboxEvent.error is a plain Prisma String, i.e. VARCHAR(191) on MySQL. */
/** `OutboxEvent.error` is TEXT (roadmap 8.1); the cap keeps a runaway stack trace out of the row. */
const MAX_ERROR_LENGTH = 4000;

/** Statuses a relay may have left a row in without finishing it (PROCESSING is the pre-4.7 claim). */
export const OUTBOX_CLAIMED_STATUSES = ['CLAIMED', 'PROCESSING'] as const;

/**
 * The one outbox semantic (roadmap 4.7, audit P2-7 / relay gap locks /
 * product outbox loss), shared by every relay:
 *
 *   1. `claim` takes a batch of PENDING rows of one family in a READ
 *      COMMITTED transaction (`FOR UPDATE SKIP LOCKED` locks only the rows it
 *      returns, never the index gaps a checkout insert needs) and marks them
 *      CLAIMED; the transaction commits before anything touches Redis.
 *   2. The relay enqueues or routes the claimed rows outside that
 *      transaction; if enqueueing fails it calls `release` and the rows are
 *      PENDING again.
 *   3. The worker ends the row: `markDone`, or `scheduleRetry` (PENDING with
 *      an exponential backoff in `nextAttemptAt`, FAILED once the retries are
 *      spent), or `markFailed` for a permanent error.
 *   4. `OutboxReaperService` returns claims that no worker finished within
 *      the stale window to PENDING through the same backoff.
 *
 * Job ids are `<row id>.<retryCount>` so a retried row never collides with a
 * job BullMQ still retains for an earlier attempt.
 */
@Injectable()
export class OutboxClaimService {
  private readonly logger = new Logger(OutboxClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsConfig: EventsFeatureConfig,
  ) {}

  /** Deterministic BullMQ job id for a claimed row (`<id>.<attempt>`: BullMQ refuses a custom id containing ':'). */
  jobIdFor(row: Pick<ClaimedOutboxRow, 'id' | 'retryCount'>): string {
    return `${row.id}.${row.retryCount}`;
  }

  /** Delay before attempt number `retryCount` (1-based) is claimed again: base × 2^(n-1), capped. */
  backoffMs(retryCount: number): number {
    const exponent = Math.max(0, retryCount - 1);
    const delay = this.eventsConfig.outboxRetryBackoffMs * Math.pow(2, exponent);
    return Math.min(delay, this.eventsConfig.outboxRetryBackoffMaxMs);
  }

  /**
   * Claims up to `batchSize` PENDING rows matching `typePredicate` (a
   * parameterised `Prisma.sql` fragment over the `type` column), oldest first.
   * Returns the rows now CLAIMED by this call.
   */
  async claim(typePredicate: Prisma.Sql, batchSize: number = this.eventsConfig.outboxProcessorBatchSize): Promise<ClaimedOutboxRow[]> {
    // The application clock decides what is due and stamps the claim (roadmap 8.2):
    // `nextAttemptAt` was written from it, so comparing it with the database clock would mix clocks.
    const now = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ClaimedOutboxRow[]>`
          SELECT id, shopId, tenantId, type, payload, correlationId, actorId, entityId, retryCount
          FROM OutboxEvent
          WHERE status = 'PENDING'
            AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now})
            AND ${typePredicate}
          ORDER BY createdAt ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return rows;
        await tx.$executeRaw`
          UPDATE OutboxEvent
          SET status = 'CLAIMED', claimedAt = ${now}, error = NULL
          WHERE id IN (${Prisma.join(rows.map((r) => r.id))}) AND status = 'PENDING'
        `;
        return rows;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 },
    );
  }

  /** Enqueueing failed after the claim committed: hand the rows back untouched. */
  async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.$executeRaw`
      UPDATE OutboxEvent
      SET status = 'PENDING', claimedAt = NULL
      WHERE id IN (${Prisma.join(ids)}) AND status = 'CLAIMED'
    `;
  }

  async markDone(id: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({ where: { id }, data: { status: 'DONE', processedAt: new Date(), error: null } });
  }

  /** A permanent failure: the row stays FAILED until an operator retries it. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id },
      data: { status: 'FAILED', error: error.slice(0, MAX_ERROR_LENGTH), retryCount: { increment: 1 }, processedAt: new Date() },
    });
  }

  /**
   * A transient failure: one more attempt after a backoff, or FAILED once
   * `EVENTS_OUTBOX_MAX_RETRIES` attempts are spent. Returns the outcome.
   */
  async scheduleRetry(id: string, error: string): Promise<'RETRY' | 'FAILED'> {
    const row = await this.prisma.outboxEvent.findUnique({ where: { id }, select: { retryCount: true } });
    if (!row) return 'FAILED';
    const attempt = row.retryCount + 1;
    if (attempt >= this.eventsConfig.outboxMaxRetries) {
      await this.markFailed(id, `retries exhausted: ${error}`);
      return 'FAILED';
    }
    const nextAttemptAt = new Date(Date.now() + this.backoffMs(attempt));
    await this.prisma.outboxEvent.updateMany({
      where: { id },
      data: { status: 'PENDING', claimedAt: null, retryCount: attempt, error: error.slice(0, MAX_ERROR_LENGTH), nextAttemptAt },
    });
    this.logger.warn(`OutboxEvent ${id} scheduled for attempt ${attempt + 1} at ${nextAttemptAt.toISOString()}: ${error}`);
    return 'RETRY';
  }

  /** Operator recovery: a FAILED row goes back to PENDING under a fresh job id. */
  async retryFailed(shopId: string, id: string, db: Pick<PrismaService, 'outboxEvent'> = this.prisma): Promise<boolean> {
    const updated = await db.outboxEvent.updateMany({
      where: { id, shopId, status: 'FAILED' },
      data: { status: 'PENDING', claimedAt: null, nextAttemptAt: null, error: null, retryCount: { increment: 1 } },
    });
    return updated.count === 1;
  }
}

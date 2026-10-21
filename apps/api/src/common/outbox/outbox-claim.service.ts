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

/** `OutboxEvent.error` is TEXT (roadmap 8.1); the cap keeps a runaway stack trace out of the row. */
const MAX_ERROR_LENGTH = 4000;

/** Statuses a relay may have left a row in without finishing it (PROCESSING is the pre-4.7 claim). */
export const OUTBOX_CLAIMED_STATUSES = ['CLAIMED', 'PROCESSING'] as const;

/** A claim as its job knows it: the row's retryCount when it was claimed (the `<id>.<retryCount>` job id). */
export interface OutboxClaim {
  retryCount: number;
}

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

  /**
   * Which rows a settle may change (audit R10): only one still claimed, and,
   * when the caller names its claim, only that claim (the retryCount its job
   * was enqueued with, which the reaper bumps when it hands a stale claim
   * back). A worker that outlived the stale window, or a replayed job, can no
   * longer end a row another claim is working on or one already DONE.
   */
  private settleWhere(id: string, claim?: OutboxClaim): Prisma.OutboxEventWhereInput {
    return { id, status: { in: [...OUTBOX_CLAIMED_STATUSES] }, ...(claim ? { retryCount: claim.retryCount } : {}) };
  }

  /** Ends the claim as DONE; false when the row was no longer this claim's. */
  async markDone(id: string, claim?: OutboxClaim): Promise<boolean> {
    const updated = await this.prisma.outboxEvent.updateMany({ where: this.settleWhere(id, claim), data: { status: 'DONE', processedAt: new Date(), error: null } });
    return updated.count === 1;
  }

  /** A permanent failure: the row stays FAILED until an operator retries it. */
  async markFailed(id: string, error: string, claim?: OutboxClaim): Promise<boolean> {
    const updated = await this.prisma.outboxEvent.updateMany({
      where: this.settleWhere(id, claim),
      data: { status: 'FAILED', error: error.slice(0, MAX_ERROR_LENGTH), retryCount: { increment: 1 }, processedAt: new Date() },
    });
    return updated.count === 1;
  }

  /**
   * A transient failure: one more attempt after a backoff, or FAILED once
   * `EVENTS_OUTBOX_MAX_RETRIES` attempts are spent. Returns the outcome;
   * 'SKIPPED' when the row was no longer this claim's (nothing changed).
   */
  async scheduleRetry(id: string, error: string, claim?: OutboxClaim): Promise<'RETRY' | 'FAILED' | 'SKIPPED'> {
    const row = await this.prisma.outboxEvent.findFirst({ where: this.settleWhere(id, claim), select: { retryCount: true } });
    if (!row) return 'SKIPPED';
    const attempt = row.retryCount + 1;
    const guard = this.settleWhere(id, { retryCount: row.retryCount });
    if (attempt >= this.eventsConfig.outboxMaxRetries) {
      const failed = await this.prisma.outboxEvent.updateMany({
        where: guard,
        data: { status: 'FAILED', error: `retries exhausted: ${error}`.slice(0, MAX_ERROR_LENGTH), retryCount: { increment: 1 }, processedAt: new Date() },
      });
      return failed.count === 1 ? 'FAILED' : 'SKIPPED';
    }
    const nextAttemptAt = new Date(Date.now() + this.backoffMs(attempt));
    const retried = await this.prisma.outboxEvent.updateMany({
      where: guard,
      data: { status: 'PENDING', claimedAt: null, retryCount: attempt, error: error.slice(0, MAX_ERROR_LENGTH), nextAttemptAt },
    });
    if (retried.count === 0) return 'SKIPPED';
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

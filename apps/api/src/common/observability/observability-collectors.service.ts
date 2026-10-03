import { Injectable, Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { queueInstances } from '../lifecycle/queue-readiness';
import { outboxOldestPendingAgeSeconds, outboxRows, queueJobs } from './metrics';

const OUTBOX_STATUSES = ['PENDING', 'CLAIMED', 'PROCESSING', 'DONE', 'FAILED'] as const;
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Gauges that are read, not counted (roadmap 7.6): outbox lag and depth from
 * the database, queue depth from BullMQ. Refreshed on every scrape by
 * `MetricsController`, each source independently, so a Redis outage still
 * leaves the outbox figures current (and vice versa).
 */
@Injectable()
export class ObservabilityCollectorsService {
  private readonly logger = new Logger(ObservabilityCollectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly modules: ModulesContainer,
  ) {}

  async refresh(): Promise<void> {
    await Promise.all([this.refreshOutbox(), this.refreshQueues()]);
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

  /** Job counts per BullMQ queue, from the queue clients already open in this process. */
  async refreshQueues(): Promise<void> {
    const { queues } = queueInstances(this.modules);
    await Promise.all(
      queues.map(async (queue) => {
        try {
          const counts = await (queue as unknown as { getJobCounts(...states: string[]): Promise<Record<string, number>> }).getJobCounts(...QUEUE_STATES);
          for (const state of QUEUE_STATES) queueJobs.set({ queue: queue.name, state }, counts[state] ?? 0);
        } catch (error) {
          this.logger.warn(`Queue metrics for ${queue.name} not refreshed: ${(error as Error).message}`);
        }
      }),
    );
  }
}

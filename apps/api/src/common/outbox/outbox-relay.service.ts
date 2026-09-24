import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { CronConfig } from '../../config/domains/cron.config';
import { buildSystemEventJob, buildSystemEventsTypePredicate, OutboxRelayRow } from './outbox-routing';

/**
 * Relays PENDING OutboxEvent rows that no domain relay owns into the
 * `system-events` queue. Partitioning is deterministic: see
 * `DOMAIN_RELAY_TYPE_PREFIXES` in ./outbox-routing.ts. Rows are claimed with
 * FOR UPDATE SKIP LOCKED so several pods can run this concurrently.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxRelayService.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('system-events') private readonly eventQueue: Queue,
    private readonly eventsConfig: EventsFeatureConfig,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap() {
    const job = new CronJob(this.cronConfig.eventsOutboxRelayCron, () => {
      void this.relayEvents();
    });
    this.schedulerRegistry.addCronJob('EventsOutboxRelayService', job);
    job.start();
  }

  async relayEvents(): Promise<void> {
    // Overlapping ticks on one pod are pointless; SKIP LOCKED covers other pods.
    if (this.isProcessing) return;
    this.isProcessing = true;

    const batchSize = this.eventsConfig.outboxProcessorBatchSize;

    try {
      await this.prisma.$transaction(async (tx) => {
        const events = await tx.$queryRaw<OutboxRelayRow[]>`
          SELECT id, shopId, type, payload, correlationId, actorId
          FROM OutboxEvent
          WHERE status = 'PENDING'
            AND ${buildSystemEventsTypePredicate()}
          ORDER BY createdAt ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        if (events.length === 0) return;

        this.logger.debug(`Relaying ${events.length} outbox events to system-events...`);

        const jobs = events.map((row) => {
          const job = buildSystemEventJob(row);
          if (!job.data.shopId) {
            // The processor will mark the row FAILED; log here so the source is visible.
            this.logger.warn(`OutboxEvent ${row.id} (${row.type}) has no shopId column or payload.shopId`);
          }
          return job;
        });

        // If BullMQ/Redis is down this throws and the transaction rolls back safely.
        await this.eventQueue.addBulk(jobs);

        const eventIds = events.map((e) => e.id);
        await tx.$executeRaw`
          UPDATE OutboxEvent
          SET status = 'DONE', processedAt = NOW(3)
          WHERE id IN (${Prisma.join(eventIds)})
        `;
      });
    } catch (error) {
      this.logger.error(`Failed to relay outbox events: ${(error as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

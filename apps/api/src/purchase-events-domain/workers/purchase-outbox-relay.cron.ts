import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';
import { CronConfig } from '../../config/domains/cron.config';

@Injectable()
export class PurchaseOutboxRelayCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurchaseOutboxRelayCron.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('purchase-events') private readonly purchaseEventsQueue: Queue,
    private readonly eventsConfig: EventsFeatureConfig,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  onApplicationBootstrap() {
    const job = new CronJob(this.cronConfig.purchaseOutboxRelayCron, () => {
      this.relayPendingEvents();
    });
    this.schedulerRegistry.addCronJob('PurchaseOutboxRelayCron', job);
    job.start();
  }

  /**
   * Sweeps the OutboxEvent table for PENDING purchase events and relays them to BullMQ.
   */
  async relayPendingEvents() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const batchSize = this.eventsConfig.outboxProcessorBatchSize;

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Fetch pending events with SKIP LOCKED
        const events: any[] = await tx.$queryRaw`
          SELECT id, type, payload, status, retryCount 
          FROM OutboxEvent 
          WHERE status = 'PENDING' 
            AND (type LIKE BINARY 'Purchase%' OR type LIKE BINARY 'GRN%' OR type LIKE BINARY 'VendorBill%' OR type LIKE BINARY 'SupplierCredit%')
          ORDER BY createdAt ASC 
          LIMIT ${batchSize} 
          FOR UPDATE SKIP LOCKED
        `;

        if (events.length === 0) return;

        this.logger.debug(`Found ${events.length} PENDING purchase events to relay.`);

        // 2. Enqueue into BullMQ
        const jobs = events.map(event => {
          return {
            name: event.type,
            data: {
              outboxEventId: event.id,
              ...event
            },
            opts: {
              jobId: event.id, // BullMQ deduplication key ensures exactly-once enqueue
            }
          };
        });

        // If BullMQ fails or Redis is down, this throws and the transaction rolls back safely
        await this.purchaseEventsQueue.addBulk(jobs);

        // 3. Update status to DONE
        const eventIds = events.map(e => e.id);
        const { Prisma } = await import('@prisma/client');
        await tx.$executeRaw`
          UPDATE OutboxEvent 
          SET status = 'DONE', processedAt = NOW(3)
          WHERE id IN (${Prisma.join(eventIds)})
        `;
      });
    } catch (err) {
      this.logger.error(`Outbox Processor encountered an error: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

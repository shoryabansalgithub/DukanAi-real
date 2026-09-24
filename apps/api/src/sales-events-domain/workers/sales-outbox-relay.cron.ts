import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Prisma } from '@prisma/client';
import { BullConfig } from '../../config/domains/bull.config';
import { CronConfig } from '../../config/domains/cron.config';
import { EventsFeatureConfig } from '../../config/domains/features/events-feature.config';

interface SalesOutboxRow {
  id: string;
  shopId: string;
  tenantId: string | null;
  correlationId: string | null;
  type: string;
  payload: unknown;
  status: string;
  retryCount: number;
}

export const SALES_EVENT_JOB_ID_PREFIX = 'sales-event-';

@Injectable()
export class SalesOutboxRelayCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(SalesOutboxRelayCron.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sales-events') private readonly salesEventsQueue: Queue,
    private readonly bullConfig: BullConfig,
    private readonly cronConfig: CronConfig,
    private readonly eventsConfig: EventsFeatureConfig,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  onApplicationBootstrap() {
    const job = new CronJob(this.cronConfig.salesOutboxRelayCron, () => {
      void this.relayPendingEvents();
    });
    this.schedulerRegistry.addCronJob('SalesOutboxRelayCron', job);
    job.start();
  }

  /**
   * Sweeps the OutboxEvent table for PENDING sales-domain events and relays them to BullMQ.
   *
   * The prefix match is LIKE BINARY (case-sensitive): 'Invoice%' are the PascalCase
   * EnterpriseInvoice domain events; the SCREAMING_CASE POS events ('INVOICE_CREATED', ...)
   * belong to the system-events relay and must never be matched here.
   */
  async relayPendingEvents() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const batchSize = this.eventsConfig.outboxProcessorBatchSize;

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Fetch pending events with SKIP LOCKED
        const events = await tx.$queryRaw<SalesOutboxRow[]>`
          SELECT id, shopId, tenantId, correlationId, type, payload, status, retryCount
          FROM OutboxEvent
          WHERE status = 'PENDING'
            AND (type LIKE BINARY 'Order%' OR type LIKE BINARY 'Invoice%' OR type LIKE BINARY 'Payment%' OR type LIKE BINARY 'Return%' OR type LIKE BINARY 'Exchange%')
          ORDER BY createdAt ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        if (events.length === 0) return;

        this.logger.log(`Found ${events.length} PENDING sales events to relay.`);

        // 2. Enqueue into BullMQ. shopId is at the top level so the router and
        //    webhook workers never have to dig it out of the payload.
        const jobs = events.map((event) => {
          const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          return {
            name: event.type,
            data: {
              eventId: event.id,
              shopId: event.shopId,
              tenantId: event.tenantId ?? undefined,
              correlationId: event.correlationId ?? undefined,
              type: event.type,
              payload,
              retryCount: event.retryCount,
            },
            opts: {
              jobId: `${SALES_EVENT_JOB_ID_PREFIX}${event.id}`, // Deterministic idempotency key
              removeOnComplete: this.bullConfig.removeOnComplete,
              attempts: this.bullConfig.defaultAttempts,
              backoff: { type: (this.bullConfig.backoffType || 'exponential') as 'exponential' | 'fixed', delay: this.bullConfig.backoffDelay }
            }
          };
        });

        // If BullMQ fails or Redis is down, this throws and the transaction rolls back safely
        await this.salesEventsQueue.addBulk(jobs);

        // 3. Update status to DONE
        const eventIds = events.map((e) => e.id);
        await tx.$executeRaw`
          UPDATE OutboxEvent
          SET status = 'DONE', processedAt = NOW(3)
          WHERE id IN (${Prisma.join(eventIds)})
        `;
      });
    } catch (error: any) {
      this.logger.error(`Failed to relay sales outbox events: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

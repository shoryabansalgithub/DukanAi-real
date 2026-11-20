import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsDeliveryService } from './events-delivery.service';
import { EventsDlqService } from './events-dlq.service';
import { EventsWebhookService } from './events-webhook.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { jobContext } from '../../iam/tenant-context/job-context';
import { OUTBOX_CLAIMED_STATUSES, OutboxClaimService } from '../../common/outbox/outbox-claim.service';

const MAX_ERROR_LENGTH = 191;

@Processor('purchase-events')
export class EventsProcessorService extends WorkerHost {
  private readonly logger = new Logger(EventsProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: EventsDeliveryService,
    private readonly dlq: EventsDlqService,
    private readonly webhooks: EventsWebhookService,
    private readonly tenantContext: TenantContextService,
    private readonly claims: OutboxClaimService,
  ) {
    super();
  }

  /** The event row names its shop; the lookup itself must span shops, so the job runs as the system tenant. */
  process(job: Job<any, any, string>): Promise<any> {
    return this.tenantContext.runAsSuperAdmin(() => this.processAsSystem(job));
  }

  private async processAsSystem(job: Job<any, any, string>): Promise<any> {
    this.logger.debug(`Processing Outbox routing job ${job.id}`);
    const eventId: string | undefined = job.data?.outboxEventId;
    if (!eventId) return;

    // The relay hands the row over CLAIMED (roadmap 4.7); a row already DONE
    // or FAILED, back to PENDING, or claimed again since this job was queued
    // (a newer retryCount) is not this job's to run (audit R10).
    const claim = typeof job.data?.retryCount === 'number' ? { retryCount: job.data.retryCount as number } : undefined;
    const outboxRecord = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!outboxRecord || !(OUTBOX_CLAIMED_STATUSES as readonly string[]).includes(outboxRecord.status)) return;
    if (claim && outboxRecord.retryCount !== claim.retryCount) return;

    try {
      // 1. Deliver internally (listeners), then externally (webhook-delivery queue), in the
      //    event's own shop context (release audit T6g): a listener never runs as the system
      //    tenant. Awaited inside the scope: Prisma promises are lazy.
      await this.tenantContext.runWithContext(jobContext(outboxRecord.shopId, job.id, outboxRecord.correlationId ?? undefined), async () => {
        await this.delivery.routeInternalEvent(outboxRecord.shopId, outboxRecord.id, outboxRecord.type, outboxRecord.payload, outboxRecord.entityId, outboxRecord.correlationId);
        await this.webhooks.dispatchWebhooksForEvent(outboxRecord.shopId, outboxRecord.id, outboxRecord.type, outboxRecord.payload, outboxRecord.retryCount);
      });

      // 2. The worker ends the row.
      await this.claims.markDone(eventId, claim);
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, MAX_ERROR_LENGTH);
      this.logger.error(`Delivery failed for outbox ${eventId}: ${message}`, error?.stack);
      // Backoff and retry through the relay; dead-letter once the retries are spent.
      const outcome = await this.claims.scheduleRetry(eventId, message, claim);
      if (outcome === 'FAILED') {
        await this.dlq.moveToDeadLetter(outboxRecord.shopId, outboxRecord.id, outboxRecord.type, outboxRecord.payload, message);
      }
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxClaimService } from '../../common/outbox/outbox-claim.service';

/**
 * Routes a product outbox event to the shop's subscribed webhooks through the
 * `webhook-delivery` queue and ends the outbox row (roadmap 4.7): DONE once
 * every delivery is queued, otherwise PENDING with backoff or FAILED through
 * `OutboxClaimService`. The former `internal-events` fan-out is gone
 * (roadmap 4.6): no processor ever consumed that queue.
 */
@Injectable()
export class EventRouterService {
  private readonly logger = new Logger(EventRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: OutboxClaimService,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
  ) {}

  /**
   * Routes an event from the Outbox to all interested external webhooks.
   */
  async routeEvent(outboxEventId: string) {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) return;

    this.logger.debug(`Routing event: ${event.type} [${event.id}]`);

    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { shopId: event.shopId, isActive: true }
      });

      const jobs = endpoints
        .filter((endpoint) => {
          const subscribedEvents = Array.isArray(endpoint.events) ? (endpoint.events as string[]) : [];
          return subscribedEvents.includes('*') || subscribedEvents.includes(event.type);
        })
        .map((endpoint) => ({
          name: 'deliver-webhook',
          data: { endpointId: endpoint.id, eventId: event.id, payload: event.payload, shopId: event.shopId },
          opts: { jobId: `webhook-${endpoint.id}-${event.id}-${event.retryCount}` },
        }));
      if (jobs.length > 0) await this.webhookQueue.addBulk(jobs);

      await this.claims.markDone(outboxEventId);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Failed to route event ${event.id}: ${message}`);
      await this.claims.scheduleRetry(outboxEventId, message);
      throw err;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EventsWebhookService {
  private readonly logger = new Logger(EventsWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue
  ) {}

  /**
   * Routes an event from the Outbox to external webhooks securely via the enterprise delivery queue.
   * `attempt` is the outbox row's retryCount: an event that is relayed again
   * (a retry, an operator's retry of a FAILED row) gets fresh job ids, so it is
   * not swallowed by a job BullMQ still retains for the earlier attempt (audit R7).
   */
  async dispatchWebhooksForEvent(shopId: string, outboxEventId: string, type: string, payload: any, attempt = 0) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { shopId, isActive: true }
    });

    const jobsToEnqueue = [];

    for (const endpoint of endpoints) {
      const subscribedEvents = endpoint.events as string[];
      if (subscribedEvents.includes('*') || subscribedEvents.includes(type)) {
        jobsToEnqueue.push({
          name: 'deliver-webhook',
          data: {
            endpointId: endpoint.id,
            eventId: outboxEventId,
            payload,
            shopId,
          },
          opts: {
            jobId: `webhook-${endpoint.id}-${outboxEventId}-${attempt}`
          }
        });
      }
    }

    if (jobsToEnqueue.length > 0) {
      this.logger.debug(`Enqueuing ${jobsToEnqueue.length} webhook deliveries for event ${outboxEventId}`);
      await this.webhookQueue.addBulk(jobsToEnqueue);
    }
  }
}

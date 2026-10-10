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
   */
  async dispatchWebhooksForEvent(shopId: string, outboxEventId: string, type: string, payload: any) {
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
            jobId: `webhook-${endpoint.id}-${outboxEventId}`
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

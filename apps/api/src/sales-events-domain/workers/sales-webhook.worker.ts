import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';
import { QueueConfig } from '../../config/domains/queue.config';
import { SalesEventJobData } from './sales-event-router.worker';

@Injectable()
@Processor('sales-webhooks')
export class SalesWebhookWorker extends WorkerHost {
  private readonly logger = new Logger(SalesWebhookWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueConfig: QueueConfig,
  ) {
    super();
  }

  async process(job: Job<SalesEventJobData, unknown, string>): Promise<{ status: string }> {
    const { shopId, payload, eventId, tenantId, correlationId } = job.data ?? {};
    const type = job.data?.type ?? job.name;

    if (!shopId || !eventId) {
      // WebhookEndpoint is not tenant-scoped by the Prisma extension: a query
      // with `shopId: undefined` would match every shop's endpoints.
      const message = `Webhook job ${String(job.id)} (${type}) is missing ${!shopId ? 'shopId' : 'eventId'}; refusing to look up endpoints.`;
      this.logger.error(message);
      throw new UnrecoverableError(message);
    }

    // Find active endpoints subscribed to this event (explicit shopId filter)
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { shopId, isActive: true }
    });

    // Filter endpoints that actually want this event
    const targetEndpoints = endpoints.filter(ep => {
      const events = Array.isArray(ep.events) ? (ep.events as string[]) : [];
      return events.includes('*') || events.includes(type);
    });

    if (targetEndpoints.length === 0) {
      return { status: 'Skipped - No Endpoints' };
    }

    const deliverPromises = targetEndpoints.map(async (endpoint) => {
      const startTime = Date.now();

      const webhookPayload = {
        eventId,
        eventType: type,
        tenantId,
        shopId,
        correlationId,
        timestamp: new Date().toISOString(),
        data: payload
      };

      const payloadString = JSON.stringify(webhookPayload);
      const signature = crypto.createHmac('sha256', endpoint.secret).update(payloadString).digest('hex');

      try {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DukanAI-Signature': `sha256=${signature}`,
            'X-DukanAI-Event': type
          },
          body: payloadString,
          signal: AbortSignal.timeout(this.queueConfig.timeout!)
        });

        const latencyMs = Date.now() - startTime;

        await this.prisma.webhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            eventId,
            eventType: type,
            payload: payloadString as any,
            status: response.ok ? 'SUCCESS' : 'FAILED',
            statusCode: response.status,
            latencyMs
          }
        });

        if (!response.ok) {
          throw new Error(`Endpoint returned status ${response.status}`);
        }

      } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        this.logger.warn(`Webhook delivery to ${endpoint.url} for event ${eventId} failed: ${error.message}`);
        await this.prisma.webhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            eventId,
            eventType: type,
            payload: payloadString as any,
            status: 'FAILED',
            errorMessage: error.message,
            latencyMs
          }
        });
        throw error; // Rethrow to trigger BullMQ retry mechanism
      }
    });

    await Promise.all(deliverPromises);
    return { status: 'Delivered' };
  }
}

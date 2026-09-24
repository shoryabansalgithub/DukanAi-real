import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { SalesRedisBroadcaster } from '../services/sales-redis-broadcaster.service';
import { BullConfig } from '../../config/domains/bull.config';

export interface SalesEventJobData {
  eventId?: string;
  shopId?: string;
  tenantId?: string;
  correlationId?: string;
  type?: string;
  payload?: unknown;
}

/**
 * Fans a relayed sales-domain event out to its consumers: the Redis Pub/Sub
 * broadcast and the `sales-webhooks` queue. The former `sales-analytics` and
 * `sales-notifications` fan-outs were removed: no processor ever consumed
 * those queues, so their jobs accumulated forever.
 */
@Injectable()
@Processor('sales-events')
export class SalesEventRouterWorker extends WorkerHost {
  private readonly logger = new Logger(SalesEventRouterWorker.name);

  constructor(
    private readonly redisBroadcaster: SalesRedisBroadcaster,
    @InjectQueue('sales-webhooks') private readonly webhooksQueue: Queue,
    private readonly bullConfig: BullConfig,
  ) {
    super();
  }

  async process(job: Job<SalesEventJobData, unknown, string>): Promise<{ status: string }> {
    const { shopId, payload, eventId } = job.data ?? {};
    const type = job.data?.type ?? job.name;

    if (!shopId || !eventId) {
      const message = `Sales event job ${String(job.id)} (${type}) is missing ${!shopId ? 'shopId' : 'eventId'}; it cannot be routed to a tenant.`;
      this.logger.error(message);
      throw new UnrecoverableError(message);
    }

    this.logger.log(`Routing Event: ${type} [${eventId}] for Shop ${shopId}`);

    // 1. Real-time broadcast (Pub/Sub)
    await this.redisBroadcaster.broadcast(shopId, type, payload);

    // 2. Route to Webhooks (shopId stays at the top level of the job data)
    await this.webhooksQueue.add(type, { ...job.data, type, shopId, eventId }, {
      jobId: `webhook-${eventId}`, // Idempotent
      attempts: this.bullConfig.defaultAttempts,
      backoff: { type: (this.bullConfig.backoffType || 'exponential') as 'exponential' | 'fixed', delay: this.bullConfig.backoffDelay }
    });

    return { status: 'Routed' };
  }
}

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { ProductWebhookDispatcherService } from '../services/webhook-dispatcher.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { jobContext, runInShopOf } from '../../iam/tenant-context/job-context';

export interface WebhookDeliveryJobData {
  endpointId: string;
  eventId: string;
  payload: unknown;
  /** Set by the router; older jobs without it resolve the shop from the endpoint. */
  shopId?: string;
}

/** Delivers a webhook inside the endpoint's shop context (roadmap 4.1, audit P2-5). */
@Processor('webhook-delivery')
@Injectable()
export class WebhookDeliveryWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);

  constructor(
    private readonly webhookDispatcher: ProductWebhookDispatcherService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobData, unknown, string>): Promise<void> {
    if (job.name !== 'deliver-webhook') return;
    this.logger.debug(`Processing webhook delivery job ${job.id}`);
    const deliver = () => this.webhookDispatcher.dispatch(job.data.endpointId, job.data.eventId, job.data.payload, String(job.id));
    if (job.data.shopId) {
      await this.tenantContext.runWithContext(jobContext(job.data.shopId, job.id), deliver);
      return;
    }
    const ran = await runInShopOf(this.tenantContext, this.prisma as unknown as Record<string, unknown>, 'webhookEndpoint', job.data.endpointId, job.id, () => deliver().then(() => true));
    if (!ran) this.logger.debug(`Webhook endpoint ${job.data.endpointId} no longer exists; delivery ${job.id} dropped.`);
  }
}

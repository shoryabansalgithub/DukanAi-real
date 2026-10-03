import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronConfig } from '../../config/domains/cron.config';
import { buildPurchaseEventsTypePredicate } from '../../common/outbox/outbox-routing';
import { OutboxClaimService } from '../../common/outbox/outbox-claim.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

@Injectable()
export class PurchaseOutboxRelayCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurchaseOutboxRelayCron.name);
  private isProcessing = false;

  constructor(
    private readonly claims: OutboxClaimService,
    @InjectQueue('purchase-events') private readonly purchaseEventsQueue: Queue,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn('PurchaseOutboxRelayCron schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.purchaseOutboxRelayCron, () => {
      void this.relayPendingEvents();
    });
    this.schedulerRegistry.addCronJob('PurchaseOutboxRelayCron', job);
    job.start();
  }

  /**
   * Claims a batch of PENDING purchase events (the `PURCHASE_RELAY_TYPE_PREFIXES`
   * family, oldest first) and enqueues them after the claim committed
   * (roadmap 4.7). The `purchase-events` worker sets DONE / FAILED. The outbox
   * spans shops, so the sweep runs as the system tenant.
   */
  relayPendingEvents(): Promise<void> {
    return this.tenantContext.runAsSuperAdmin(() => this.relayPendingEventsAsSystem());
  }

  private async relayPendingEventsAsSystem(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const rows = await this.claims.claim(buildPurchaseEventsTypePredicate());
      if (rows.length === 0) return;
      this.logger.debug(`Found ${rows.length} PENDING purchase events to relay.`);

      const jobs = rows.map((row) => ({
        name: row.type,
        data: { outboxEventId: row.id, shopId: row.shopId, type: row.type, retryCount: row.retryCount },
        opts: { jobId: this.claims.jobIdFor(row) },
      }));

      try {
        await this.purchaseEventsQueue.addBulk(jobs);
      } catch (error) {
        await this.claims.release(rows.map((r) => r.id));
        throw error;
      }
    } catch (err) {
      this.logger.error(`Outbox Processor encountered an error: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

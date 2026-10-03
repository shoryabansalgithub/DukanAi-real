import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventRouterService } from '../services/event-router.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CronConfig } from '../../config/domains/cron.config';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { OutboxClaimService } from '../../common/outbox/outbox-claim.service';
import { buildProductEventsTypePredicate } from '../../common/outbox/outbox-routing';

/**
 * Product / inventory outbox relay. Claims a batch through the shared claim
 * semantic (roadmap 4.7) and routes each row to the shop's webhooks after the
 * claim committed; `EventRouterService` ends every row (DONE, or PENDING
 * with backoff / FAILED through `OutboxClaimService`), and the reaper covers
 * a crash between the two.
 */
@Injectable()
export class OutboxProcessorWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxProcessorWorker.name);
  private isProcessing = false;

  constructor(
    private readonly claims: OutboxClaimService,
    private readonly eventRouter: EventRouterService,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn('ProductOutboxProcessorWorker schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.productOutboxRelayCron, () => {
      void this.processOutbox();
    });
    this.schedulerRegistry.addCronJob('ProductOutboxProcessorWorker', job);
    job.start();
  }

  /** Drains every shop's pending product events; runs as the system tenant because the outbox spans shops. */
  processOutbox(): Promise<void> {
    return this.tenantContext.runAsSuperAdmin(() => this.processOutboxAsSystem());
  }

  private async processOutboxAsSystem(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const rows = await this.claims.claim(buildProductEventsTypePredicate());
      if (rows.length === 0) return;
      this.logger.debug(`Claimed ${rows.length} product outbox events...`);

      for (const row of rows) {
        try {
          await this.eventRouter.routeEvent(row.id);
        } catch (error) {
          this.logger.error(`Failed to route event ${row.id}: ${(error as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Outbox Processor encountered an error: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

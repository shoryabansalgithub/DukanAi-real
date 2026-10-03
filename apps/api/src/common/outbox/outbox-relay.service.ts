import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CronConfig } from '../../config/domains/cron.config';
import { buildSystemEventJob, buildSystemEventsTypePredicate } from './outbox-routing';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { OutboxClaimService } from './outbox-claim.service';

/**
 * Relays PENDING OutboxEvent rows that no domain relay owns into the
 * `system-events` queue. Partitioning is deterministic: see
 * `DOMAIN_RELAY_TYPE_PREFIXES` in ./outbox-routing.ts. The claim runs in
 * READ COMMITTED with SKIP LOCKED and commits before the enqueue (roadmap
 * 4.7); the worker marks the row DONE or FAILED.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxRelayService.name);
  private isProcessing = false;

  constructor(
    private readonly claims: OutboxClaimService,
    @InjectQueue('system-events') private readonly eventQueue: Queue,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn('EventsOutboxRelayService schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.eventsOutboxRelayCron, () => {
      void this.relayEvents();
    });
    this.schedulerRegistry.addCronJob('EventsOutboxRelayService', job);
    job.start();
  }

  /** Relays every shop's pending events; runs as the system tenant because the outbox spans shops. */
  relayEvents(): Promise<void> {
    return this.tenantContext.runAsSuperAdmin(() => this.relayEventsAsSystem());
  }

  private async relayEventsAsSystem(): Promise<void> {
    // Overlapping ticks on one pod are pointless; SKIP LOCKED covers other pods.
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const rows = await this.claims.claim(buildSystemEventsTypePredicate());
      if (rows.length === 0) return;
      this.logger.debug(`Relaying ${rows.length} outbox events to system-events...`);

      const jobs = rows.map((row) => {
        const job = buildSystemEventJob(row);
        if (!job.data.shopId) {
          // The processor will mark the row FAILED; log here so the source is visible.
          this.logger.warn(`OutboxEvent ${row.id} (${row.type}) has no shopId column or payload.shopId`);
        }
        return { ...job, opts: { jobId: this.claims.jobIdFor(row) } };
      });

      try {
        // Outside the claim transaction: a Redis failure hands the rows back instead of holding row locks.
        await this.eventQueue.addBulk(jobs);
      } catch (error) {
        await this.claims.release(rows.map((r) => r.id));
        throw error;
      }
    } catch (error) {
      this.logger.error(`Failed to relay outbox events: ${(error as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }
}

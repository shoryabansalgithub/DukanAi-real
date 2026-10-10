import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullConfig } from '../../config/domains/bull.config';
import { OutboxRelayService } from './outbox-relay.service';
import { SystemEventsProcessor } from './system-events.processor';
import { InventoryModule } from '../../inventory/inventory.module';
import { OutboxClaimService } from './outbox-claim.service';
import { OutboxReaperService } from './outbox-reaper.service';
import { CronLockModule } from '../cron-lock/cron-lock.module';

/**
 * The outbox core (roadmap 4.7): the claim semantic every relay shares
 * (`OutboxClaimService`, exported), the stale-claim reaper, and the
 * system-events relay + worker for the POS/billing events.
 */
@Module({
  imports: [
    // Retry policy is declared here rather than inherited, so the processor's
    // final-attempt check has a reliable `job.opts.attempts` to compare against.
    BullModule.registerQueueAsync({
      name: 'system-events',
      inject: [BullConfig],
      useFactory: (bullConfig: BullConfig) => ({
        defaultJobOptions: {
          attempts: bullConfig.defaultAttempts,
          backoff: {
            type: bullConfig.backoffType as 'exponential' | 'fixed',
            delay: bullConfig.backoffDelay,
          },
        },
      }),
    }),
    // InventoryGateway is used by the processor to broadcast low-stock alerts.
    InventoryModule,
    CronLockModule,
  ],
  providers: [OutboxClaimService, OutboxReaperService, OutboxRelayService, SystemEventsProcessor],
  exports: [OutboxClaimService],
})
export class OutboxModule {}

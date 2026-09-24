import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullConfig } from '../../config/domains/bull.config';
import { OutboxRelayService } from './outbox-relay.service';
import { SystemEventsProcessor } from './system-events.processor';
import { InventoryModule } from '../../inventory/inventory.module';

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
  ],
  providers: [OutboxRelayService, SystemEventsProcessor],
})
export class OutboxModule {}

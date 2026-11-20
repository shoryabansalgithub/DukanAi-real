import { BullModule } from '@nestjs/bullmq';
import { BullConfig } from '../config/domains/bull.config';
import { EventsFeatureConfig } from '../config/domains/features/events-feature.config';
import { bullDefaultJobOptions } from '../common/queues/job-options';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

/**
 * The `webhook-delivery` queue with its own retry policy (audit R7): a
 * receiver that is down for a deploy must not exhaust the attempts in three
 * seconds, so a delivery is tried `EVENTS_WEBHOOK_DELIVERY_ATTEMPTS` times
 * with an exponential backoff from `EVENTS_WEBHOOK_RETRY_BACKOFF_MS` (8 from
 * 30 s span about an hour); finished and failed jobs are removed like every
 * queue's (`bullDefaultJobOptions`). Both producers (the product relay and
 * the purchase events service) register the queue through this, so a job
 * gets the same options whichever module adds it.
 */
export function webhookDeliveryQueue() {
  return BullModule.registerQueueAsync({
    name: WEBHOOK_DELIVERY_QUEUE,
    inject: [BullConfig, EventsFeatureConfig],
    useFactory: (bullConfig: BullConfig, events: EventsFeatureConfig) => ({
      defaultJobOptions: bullDefaultJobOptions(bullConfig, {
        attempts: events.webhookDeliveryAttempts,
        backoff: { type: 'exponential', delay: events.webhookRetryBackoffMs },
      }),
    }),
  });
}

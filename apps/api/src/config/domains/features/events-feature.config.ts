import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { BooleanFromEnv, IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Event listing, outbox batch and webhook delivery settings. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Events', feature: 'Events Domain', version: '1.2.0', description: 'Configuration for Universal Events Features' })
export class EventsFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_RECENT_LIMIT')
  recentEventsLimit: number = 50;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_WEBHOOK_DELIVERY_LIMIT')
  webhookDeliveryLimit: number = 5;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_OUTBOX_PROCESSOR_BATCH_SIZE')
  outboxProcessorBatchSize: number = 100;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_WEBHOOK_TIMEOUT_MS')
  webhookTimeoutMs: number = 10000;

  /** A claimed outbox row that no worker finished within this window is reaped back to PENDING (roadmap 4.7). */
  @IsInt()
  @Min(10_000)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_OUTBOX_STALE_CLAIM_MS')
  outboxStaleClaimMs: number = 5 * 60 * 1000;

  /** Attempts (first delivery included) before an outbox row is FAILED for an operator to retry. */
  @IsInt()
  @Min(1)
  @Max(50)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_OUTBOX_MAX_RETRIES')
  outboxMaxRetries: number = 5;

  /** Base of the exponential backoff between outbox attempts (doubles per attempt). */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_OUTBOX_RETRY_BACKOFF_MS')
  outboxRetryBackoffMs: number = 30_000;

  /** Cap of that backoff. */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_OUTBOX_RETRY_BACKOFF_MAX_MS')
  outboxRetryBackoffMaxMs: number = 60 * 60 * 1000;

  /** Webhook endpoints must be https unless this is on (development only; never in production). */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('EVENTS_WEBHOOK_ALLOW_HTTP')
  webhookAllowHttp: boolean = false;

  /** Largest webhook response body read back (the body is only logged). */
  @IsInt()
  @Min(1024)
  @IntegerFromEnv()
  @EnvVariable('EVENTS_WEBHOOK_MAX_RESPONSE_BYTES')
  webhookMaxResponseBytes: number = 64 * 1024;
}

import { Injectable } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, Max, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv, IntegerFromEnv, StringFromEnv } from '../hydrate-from-env';

export const BULL_BACKOFF_TYPES = ['exponential', 'fixed'] as const;
export type BullBackoffType = (typeof BULL_BACKOFF_TYPES)[number];

/**
 * Default job options for the BullMQ queues. Hydrated with `hydrateFromEnv`:
 * booleans accept true/false spellings only (the old implicit conversion
 * turned the string "false" into true), an unset or blank variable keeps the
 * default, and anything else fails boot.
 *
 * Every queue gets these through `bullDefaultJobOptions`
 * (`src/common/queues/job-options.ts`), including a queue that declares its
 * own attempts (BullMQ merges queue options over the root ones shallowly, so
 * a queue-level `defaultJobOptions` used to drop `removeOnComplete` and kept
 * every finished job in Redis). A job set that is kept (`BULL_REMOVE_ON_*`
 * false) is bounded by age and count, never kept for good.
 */
@Injectable()
@ConfigDomain({ owner: 'Bull', feature: 'Configuration', version: '2.0.0', description: 'BullConfig Domain' })
export class BullConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('BULL_ATTEMPTS')
  defaultAttempts: number = 3;

  @IsIn(BULL_BACKOFF_TYPES)
  @StringFromEnv()
  @EnvVariable('BULL_BACKOFF_TYPE')
  backoffType: BullBackoffType = 'exponential';

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('BULL_BACKOFF_DELAY')
  backoffDelay: number = 1000;

  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('BULL_REMOVE_ON_COMPLETE')
  removeOnComplete: boolean = true;

  /** False keeps failed jobs for inspection, bounded by BULL_KEEP_JOBS_AGE_SECONDS / BULL_KEEP_JOBS_COUNT. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('BULL_REMOVE_ON_FAIL')
  removeOnFail: boolean = false;

  /** A kept finished or failed job is removed once it is older than this (seconds). */
  @IsInt()
  @Min(60)
  @Max(90 * 24 * 3600)
  @IntegerFromEnv()
  @EnvVariable('BULL_KEEP_JOBS_AGE_SECONDS')
  keepJobsAgeSeconds: number = 7 * 24 * 3600;

  /** At most this many kept finished or failed jobs per queue. */
  @IsInt()
  @Min(1)
  @Max(100_000)
  @IntegerFromEnv()
  @EnvVariable('BULL_KEEP_JOBS_COUNT')
  keepJobsCount: number = 1000;

  /**
   * How long a request waits for Redis to accept a job (an import, a media
   * thumbnail) before it answers 503 QUEUE_UNAVAILABLE: BullMQ queues commands
   * while Redis is unreachable, so an unbounded `add` hung the request.
   */
  @IsInt()
  @Min(100)
  @Max(60_000)
  @IntegerFromEnv()
  @EnvVariable('BULL_ENQUEUE_TIMEOUT_MS')
  enqueueTimeoutMs: number = 5000;
}

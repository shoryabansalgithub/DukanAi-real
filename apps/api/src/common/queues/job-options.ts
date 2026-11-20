import type { DefaultJobOptions, KeepJobs } from 'bullmq';
import { BullConfig } from '../../config/domains/bull.config';

/**
 * The job options every BullMQ queue runs with (audit R1). BullMQ merges a
 * queue's registration over the root options shallowly: a queue that sets
 * its own `defaultJobOptions` (attempts, backoff) replaces the root's object
 * whole, which is how `system-events` lost `removeOnComplete` and kept every
 * finished job of every sale in Redis for good. So a queue never writes
 * `defaultJobOptions` by hand: the root and every queue that needs its own
 * retry policy build them here, and the removal settings always come along.
 *
 * Removal is never "keep for good": `BULL_REMOVE_ON_*=false` keeps the jobs
 * for inspection, bounded by age and count (`BULL_KEEP_JOBS_*`).
 */
export function keptJobs(config: Pick<BullConfig, 'keepJobsAgeSeconds' | 'keepJobsCount'>): KeepJobs {
  return { age: config.keepJobsAgeSeconds, count: config.keepJobsCount };
}

export function bullDefaultJobOptions(
  config: BullConfig,
  overrides: Pick<DefaultJobOptions, 'attempts' | 'backoff'> = {},
): DefaultJobOptions {
  return {
    removeOnComplete: config.removeOnComplete ? true : keptJobs(config),
    removeOnFail: config.removeOnFail ? true : keptJobs(config),
    attempts: config.defaultAttempts,
    backoff: { type: config.backoffType, delay: config.backoffDelay },
    ...overrides,
  };
}

/** True when a `removeOnComplete` / `removeOnFail` value removes the jobs, at once or by an age or count bound. */
export function isBoundedRemoval(value: DefaultJobOptions['removeOnComplete']): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value >= 0;
  if (value && typeof value === 'object') {
    const keep = value as { age?: number; count?: number };
    return (typeof keep.age === 'number' && keep.age > 0) || (typeof keep.count === 'number' && keep.count >= 0);
  }
  return false;
}

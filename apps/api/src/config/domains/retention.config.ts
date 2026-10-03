import { Injectable } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv } from '../hydrate-from-env';

/**
 * Retention (roadmap 7.8): how long rows that no flow reads any more stay in
 * the database before the nightly sweep (`RetentionSweepService`, schedule
 * `CRON_RETENTION_SWEEP`) removes them. Hydrated with `hydrateFromEnv`: an
 * unset or blank variable keeps the default, garbage fails boot.
 *
 * - Refresh tokens and password-reset tokens are kept
 *   `RETENTION_EXPIRED_TOKENS_DAYS` past their expiry (or use): a consumed
 *   refresh token must outlive its idle lifetime for reuse detection, and the
 *   login trail (address, user agent) stays readable for a while.
 * - DONE outbox rows go `RETENTION_OUTBOX_DONE_DAYS` after they were created;
 *   FAILED rows stay for an operator to retry (`POST /sales/events/retry`).
 * - SearchHistory feeds the seven-day popular-searches card, ProductEventLog
 *   the event replay, which then covers only what is retained.
 * - A run deletes `RETENTION_BATCH_SIZE` rows per statement and at most
 *   `RETENTION_MAX_BATCHES_PER_RUN` batches per table, so a backlog drains
 *   over several nights instead of one long statement holding locks.
 */
@Injectable()
@ConfigDomain({ owner: 'Retention', feature: 'Configuration', version: '1.0.0', description: 'RetentionConfig Domain' })
export class RetentionConfig {
  @IsInt()
  @Min(0)
  @Max(3650)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_EXPIRED_TOKENS_DAYS')
  expiredTokensDays: number = 7;

  @IsInt()
  @Min(1)
  @Max(3650)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_OUTBOX_DONE_DAYS')
  outboxDoneDays: number = 14;

  /** At least the seven days `SearchAnalyticsService.getPopularSearches` reads. */
  @IsInt()
  @Min(7)
  @Max(3650)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_SEARCH_HISTORY_DAYS')
  searchHistoryDays: number = 90;

  @IsInt()
  @Min(1)
  @Max(3650)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_PRODUCT_EVENT_LOG_DAYS')
  productEventLogDays: number = 180;

  @IsInt()
  @Min(100)
  @Max(10_000)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_BATCH_SIZE')
  batchSize: number = 1000;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IntegerFromEnv()
  @EnvVariable('RETENTION_MAX_BATCHES_PER_RUN')
  maxBatchesPerRun: number = 200;
}

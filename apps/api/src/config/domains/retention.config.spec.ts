import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { hydrateFromEnv } from '../hydrate-from-env';
import { RetentionConfig } from './retention.config';

describe('RetentionConfig (roadmap 7.8)', () => {
  it('keeps the defaults when nothing is set', () => {
    const config = hydrateFromEnv(RetentionConfig, {});
    expect(config).toMatchObject({ expiredTokensDays: 7, outboxDoneDays: 14, searchHistoryDays: 90, productEventLogDays: 180, batchSize: 1000, maxBatchesPerRun: 200 });
    expect(validateSync(config)).toEqual([]);
  });

  it('hydrates every window from the environment; blank keeps the default, 0 is a value where allowed', () => {
    const config = hydrateFromEnv(RetentionConfig, {
      RETENTION_EXPIRED_TOKENS_DAYS: '0',
      RETENTION_OUTBOX_DONE_DAYS: '30',
      RETENTION_SEARCH_HISTORY_DAYS: '',
      RETENTION_PRODUCT_EVENT_LOG_DAYS: '365',
      RETENTION_BATCH_SIZE: '500',
      RETENTION_MAX_BATCHES_PER_RUN: '10',
    });
    expect(config).toMatchObject({ expiredTokensDays: 0, outboxDoneDays: 30, searchHistoryDays: 90, productEventLogDays: 365, batchSize: 500, maxBatchesPerRun: 10 });
    expect(validateSync(config)).toEqual([]);
  });

  it.each([
    ['a non-integer window', { RETENTION_OUTBOX_DONE_DAYS: 'soon' }, 'outboxDoneDays'],
    ['a zero outbox window', { RETENTION_OUTBOX_DONE_DAYS: '0' }, 'outboxDoneDays'],
    ['a search window under the seven days the analytics read', { RETENTION_SEARCH_HISTORY_DAYS: '3' }, 'searchHistoryDays'],
    ['a batch under 100 rows', { RETENTION_BATCH_SIZE: '10' }, 'batchSize'],
    ['a batch budget of zero', { RETENTION_MAX_BATCHES_PER_RUN: '0' }, 'maxBatchesPerRun'],
    ['a window over ten years', { RETENTION_PRODUCT_EVENT_LOG_DAYS: '4000' }, 'productEventLogDays'],
  ])('rejects %s', (_label, env, property) => {
    const errors = validateSync(hydrateFromEnv(RetentionConfig, env));
    expect(errors.map((e) => e.property)).toEqual([property]);
  });
});

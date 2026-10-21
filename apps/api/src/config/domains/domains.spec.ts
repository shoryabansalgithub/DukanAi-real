import 'reflect-metadata';
import { hydrateFromEnv } from '../hydrate-from-env';
import { CronConfig } from './cron.config';
import { validateSync } from 'class-validator';
import { SecurityConfig } from './security.config';
import { BullConfig } from './bull.config';
import { SalesFeatureConfig } from './features/sales-feature.config';
import { CacheConfig } from './cache.config';
import { BillingFeatureConfig } from './features/billing-feature.config';
import { OcrFeatureConfig } from './features/ocr-feature.config';

describe('Configuration Domains', () => {
  describe('SecurityConfig', () => {
    it('keeps the defaults (millisecond windows) when no env variables are provided', () => {
      const config = hydrateFromEnv(SecurityConfig, {});
      expect(config.bcryptRounds).toBe(10);
      expect(config.rateLimitShortTtlMs).toBe(10000);
      expect(config.rateLimitMediumTtlMs).toBe(60000);
      expect(config.rateLimitLongTtlMs).toBe(3600000);
      expect(config.authRateLimitShortLimit).toBe(5);
      expect(config.maxLoginAttempts).toBe(5);
      expect(validateSync(config)).toEqual([]);
    });

    it('hydrates values from environment variables', () => {
      const config = hydrateFromEnv(SecurityConfig, {
        BCRYPT_ROUNDS: '12',
        RATE_LIMIT_SHORT_TTL_MS: '2000',
        AUTH_RATE_LIMIT_SHORT_LIMIT: '3',
        SECURITY_MAX_LOGIN_ATTEMPTS: '10',
      });
      expect(config.bcryptRounds).toBe(12);
      expect(config.rateLimitShortTtlMs).toBe(2000);
      expect(config.authRateLimitShortLimit).toBe(3);
      expect(config.maxLoginAttempts).toBe(10);
      expect(validateSync(config)).toEqual([]);
    });

    it('ignores the old second-based RATE_LIMIT_*_TTL keys instead of reading them as milliseconds', () => {
      const config = hydrateFromEnv(SecurityConfig, { RATE_LIMIT_SHORT_TTL: '10', RATE_LIMIT_LONG_TTL: '3600' });
      expect(config.rateLimitShortTtlMs).toBe(10000);
      expect(config.rateLimitLongTtlMs).toBe(3600000);
    });

    it.each([
      ['a sub-second window', { RATE_LIMIT_SHORT_TTL_MS: '10' }, 'rateLimitShortTtlMs'],
      ['a non-integer window', { RATE_LIMIT_MEDIUM_TTL_MS: 'soon' }, 'rateLimitMediumTtlMs'],
      ['a zero limit', { AUTH_RATE_LIMIT_LONG_LIMIT: '0' }, 'authRateLimitLongLimit'],
      ['a bcrypt cost outside 4..31', { BCRYPT_ROUNDS: '3' }, 'bcryptRounds'],
    ])('rejects %s', (_label, env, property) => {
      const errors = validateSync(hydrateFromEnv(SecurityConfig, env));
      expect(errors.map((e) => e.property)).toEqual([property]);
    });
  });

  describe('BullConfig', () => {
    it('keeps the defaults when nothing is set', () => {
      const config = hydrateFromEnv(BullConfig, {});
      expect(config).toMatchObject({ defaultAttempts: 3, backoffType: 'exponential', backoffDelay: 1000, removeOnComplete: true, removeOnFail: false });
      expect(validateSync(config)).toEqual([]);
    });

    it('reads boolean strings literally: "false" is false and "true" is true (the old implicit conversion inverted them)', () => {
      const config = hydrateFromEnv(BullConfig, { BULL_REMOVE_ON_COMPLETE: 'false', BULL_REMOVE_ON_FAIL: 'true', BULL_BACKOFF_TYPE: 'fixed', BULL_BACKOFF_DELAY: '0' });
      expect(config).toMatchObject({ removeOnComplete: false, removeOnFail: true, backoffType: 'fixed', backoffDelay: 0 });
      expect(validateSync(config)).toEqual([]);
    });

    it.each([
      ['a non-boolean flag', { BULL_REMOVE_ON_FAIL: 'maybe' }, 'removeOnFail'],
      ['an unknown backoff type', { BULL_BACKOFF_TYPE: 'linear' }, 'backoffType'],
      ['zero attempts', { BULL_ATTEMPTS: '0' }, 'defaultAttempts'],
      ['a non-integer delay', { BULL_BACKOFF_DELAY: 'soon' }, 'backoffDelay'],
    ])('rejects %s', (_label, env, property) => {
      expect(validateSync(hydrateFromEnv(BullConfig, env)).map((e) => e.property)).toEqual([property]);
    });
  });

  describe('SalesFeatureConfig', () => {
    it('keeps the defaults when nothing is set', () => {
      const config = hydrateFromEnv(SalesFeatureConfig, {});
      expect(config).toMatchObject({ recentEventsLimit: 100, defaultCreditLimit: 5000 });
      expect(validateSync(config)).toEqual([]);
    });

    it('overrides from the environment and allows 0 where the bound does', () => {
      const config = hydrateFromEnv(SalesFeatureConfig, { SALES_RECENT_EVENTS_LIMIT: '250', SALES_DEFAULT_CREDIT_LIMIT: '0' });
      expect(config).toMatchObject({ recentEventsLimit: 250, defaultCreditLimit: 0 });
      expect(validateSync(config)).toEqual([]);
    });

    it.each([
      ['a negative credit limit', { SALES_DEFAULT_CREDIT_LIMIT: '-100' }, 'defaultCreditLimit'],
      ['garbage', { SALES_RECENT_EVENTS_LIMIT: 'lots' }, 'recentEventsLimit'],
      ['a zero list size', { SALES_RECENT_EVENTS_LIMIT: '0' }, 'recentEventsLimit'],
    ])('rejects %s', (_label, env, property) => {
      expect(validateSync(hydrateFromEnv(SalesFeatureConfig, env)).map((e) => e.property)).toEqual([property]);
    });
  });

  describe('BillingFeatureConfig and OcrFeatureConfig (decimal bounds)', () => {
    it('bounds the cashier discount to 0..100 and the OCR threshold to 0..1, reading decimals', () => {
      expect(validateSync(hydrateFromEnv(BillingFeatureConfig, { BILLING_CASHIER_MAX_DISCOUNT_PERCENT: '12.5' }))).toEqual([]);
      expect(hydrateFromEnv(BillingFeatureConfig, { BILLING_CASHIER_MAX_DISCOUNT_PERCENT: '12.5' }).cashierMaxDiscountPercent).toBe(12.5);
      expect(hydrateFromEnv(BillingFeatureConfig, { BILLING_CASHIER_MAX_DISCOUNT_PERCENT: '0' }).cashierMaxDiscountPercent).toBe(0);
      for (const bad of ['101', '-1', 'ten', '1e400']) {
        expect(validateSync(hydrateFromEnv(BillingFeatureConfig, { BILLING_CASHIER_MAX_DISCOUNT_PERCENT: bad })).map((e) => e.property)).toEqual(['cashierMaxDiscountPercent']);
      }
      expect(validateSync(hydrateFromEnv(OcrFeatureConfig, { OCR_FUZZY_MATCH_THRESHOLD: '0.85' }))).toEqual([]);
      expect(validateSync(hydrateFromEnv(OcrFeatureConfig, { OCR_FUZZY_MATCH_THRESHOLD: '1.5' })).map((e) => e.property)).toEqual(['fuzzyMatchThreshold']);
    });

    it('bounds the OCR upload cap, item cap and model name (roadmap 4.4)', () => {
      const defaults = hydrateFromEnv(OcrFeatureConfig, {});
      expect(defaults.maxImageBytes).toBe(10 * 1024 * 1024);
      expect(defaults.maxItems).toBe(100);
      expect(defaults.model).toBe('gemini-2.0-flash');
      const custom = hydrateFromEnv(OcrFeatureConfig, { OCR_MAX_IMAGE_BYTES: '2097152', OCR_MAX_ITEMS: '20', OCR_MODEL: 'gemini-2.5-flash' });
      expect(validateSync(custom)).toEqual([]);
      expect(custom.maxImageBytes).toBe(2097152);
      expect(custom.maxItems).toBe(20);
      expect(validateSync(hydrateFromEnv(OcrFeatureConfig, { OCR_MAX_IMAGE_BYTES: '1024' })).map((e) => e.property)).toEqual(['maxImageBytes']);
      expect(validateSync(hydrateFromEnv(OcrFeatureConfig, { OCR_MAX_ITEMS: '0' })).map((e) => e.property)).toEqual(['maxItems']);
      expect(validateSync(hydrateFromEnv(OcrFeatureConfig, { OCR_MODEL: 'models/x y' })).map((e) => e.property)).toEqual(['model']);
    });
  });

  describe('CacheConfig (hydrateFromEnv)', () => {
    it('keeps every default when nothing is set, including fields without their own transform', () => {
      const config = hydrateFromEnv(CacheConfig, {});
      expect(validateSync(config)).toEqual([]);
      expect(config.ttl).toBe(3600000);
      expect(config.customerSearchTtlMs).toBe(60000);
      expect(config.analyticsKpiTtlMs).toBe(60000);
    });

    it('reads integers from the environment, allows 0 and treats blank as unset', () => {
      const config = hydrateFromEnv(CacheConfig, { CACHE_TTL: '0', CACHE_ANALYTICS_KPI_TTL_MS: ' 250 ', CACHE_GRN_TTL_MS: '' });
      expect(validateSync(config)).toEqual([]);
      expect(config.ttl).toBe(0);
      expect(config.analyticsKpiTtlMs).toBe(250);
      expect(config.grnTtlMs).toBe(60000);
    });

    it('rejects values that are not integers instead of silently using the default', () => {
      for (const bad of ['abc', '1.5', '10ms']) {
        const errors = validateSync(hydrateFromEnv(CacheConfig, { CACHE_GRN_TTL_MS: bad }));
        expect(errors.map((e) => e.property)).toEqual(['grnTtlMs']);
      }
      expect(validateSync(hydrateFromEnv(CacheConfig, { CACHE_TTL: '-1' })).map((e) => e.property)).toEqual(['ttl']);
    });

    it('copies only declared variables, never the rest of the environment', () => {
      const config = hydrateFromEnv(CacheConfig, { JWT_SECRET: 'top-secret', CACHE_TTL: '5' });
      expect(config).not.toHaveProperty('JWT_SECRET');
      expect(config.ttl).toBe(5);
    });
  });

  describe('CronConfig (hydrateFromEnv)', () => {
    it('keeps the defaults when nothing is set', () => {
      const config = hydrateFromEnv(CronConfig, {});
      expect(validateSync(config)).toEqual([]);
      expect(config.outboxReaperCron).toBe('* * * * *');
      expect(config.analyticsJobCron).toBe('0 0 * * *');
    });

    it('reads schedules from the environment; blank keeps the default', () => {
      const config = hydrateFromEnv(CronConfig, { CRON_OUTBOX_REAPER: ' 0 0 29 2 * ', CRON_ANALYTICS_JOB: '' });
      expect(validateSync(config)).toEqual([]);
      expect(config.outboxReaperCron).toBe('0 0 29 2 *');
      expect(config.analyticsJobCron).toBe('0 0 * * *');
    });

    it('reads the CRON_ENABLED switch and rejects anything that is not a boolean', () => {
      expect(hydrateFromEnv(CronConfig, {}).enabled).toBe(true);
      expect(hydrateFromEnv(CronConfig, { CRON_ENABLED: 'false' }).enabled).toBe(false);
      expect(hydrateFromEnv(CronConfig, { CRON_ENABLED: 'FALSE' }).enabled).toBe(false);
      expect(hydrateFromEnv(CronConfig, { CRON_ENABLED: '' }).enabled).toBe(true);
      expect(validateSync(hydrateFromEnv(CronConfig, { CRON_ENABLED: 'maybe' })).map((e) => e.property)).toEqual(['enabled']);
    });

    it('rejects a schedule that can never run (CronJob.start() would throw on it)', () => {
      const errors = validateSync(hydrateFromEnv(CronConfig, { CRON_OUTBOX_REAPER: '0 0 31 2 *' }));
      expect(errors.map((e) => e.property)).toEqual(['outboxReaperCron']);
    });

    it('rejects an invalid cron expression with the property named', () => {
      const errors = validateSync(hydrateFromEnv(CronConfig, { CRON_INVENTORY_RECON: 'every 5 minutes' }));
      expect(errors.map((e) => e.property)).toEqual(['inventoryReconCron']);
      expect(Object.values(errors[0].constraints ?? {}).join()).toContain('valid cron expression');
    });
  });
});

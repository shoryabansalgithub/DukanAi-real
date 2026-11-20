import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { hydrateFromEnv } from '../hydrate-from-env';
import { MonitoringConfig } from './monitoring.config';

describe('MonitoringConfig (roadmap 7.6)', () => {
  it('exposes metrics without a token and keeps error tracking off by default', () => {
    const config = hydrateFromEnv(MonitoringConfig, {});
    expect(config).toMatchObject({ metricsEnabled: true, metricsToken: undefined, sentryDsn: undefined, sentryTracesSampleRate: 0, appRelease: undefined });
    expect(config.errorTrackingEnabled).toBe(false);
    expect(validateSync(config)).toEqual([]);
  });

  it('hydrates every key from the environment', () => {
    const config = hydrateFromEnv(MonitoringConfig, {
      METRICS_ENABLED: 'false',
      METRICS_TOKEN: 'a-scrape-token-of-sufficient-length',
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
      APP_RELEASE: 'api@1.2.3',
    });
    expect(config).toMatchObject({
      metricsEnabled: false,
      metricsToken: 'a-scrape-token-of-sufficient-length',
      sentryDsn: 'https://key@o1.ingest.sentry.io/1',
      sentryEnvironment: 'staging',
      sentryTracesSampleRate: 0.25,
      appRelease: 'api@1.2.3',
    });
    expect(config.errorTrackingEnabled).toBe(true);
    expect(validateSync(config)).toEqual([]);
  });

  it.each([
    ['a short metrics token', { METRICS_TOKEN: 'short' }, 'metricsToken'],
    ['a placeholder metrics token', { METRICS_TOKEN: 'your_metrics_token_goes_here' }, 'metricsToken'],
    ['a placeholder DSN', { SENTRY_DSN: '___REPLACE_ME_IN_PRODUCTION___' }, 'sentryDsn'],
    ['a DSN that is not a URL', { SENTRY_DSN: 'key@sentry' }, 'sentryDsn'],
    ['a sample rate above 1', { SENTRY_TRACES_SAMPLE_RATE: '1.5' }, 'sentryTracesSampleRate'],
    ['a sample rate that is not a number', { SENTRY_TRACES_SAMPLE_RATE: 'some' }, 'sentryTracesSampleRate'],
    ['a metrics switch that is not a boolean', { METRICS_ENABLED: 'nope' }, 'metricsEnabled'],
  ])('rejects %s', (_label, env, property) => {
    const errors = validateSync(hydrateFromEnv(MonitoringConfig, env));
    expect(errors.map((e) => e.property)).toEqual([property]);
  });
});

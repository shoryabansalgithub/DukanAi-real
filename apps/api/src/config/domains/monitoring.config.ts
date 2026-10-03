import { Injectable } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv, NumberFromEnv, StringFromEnv } from '../hydrate-from-env';
import { IsNotPlaceholder } from '../validation/env-rules';

/**
 * Metrics and error tracking (roadmap 7.6). Hydrated with `hydrateFromEnv`.
 *
 * - `METRICS_ENABLED` exposes `GET /api/metrics` (Prometheus text format).
 *   Keep the endpoint off the public internet: the scrape target is the
 *   internal address, and `METRICS_TOKEN` (when set) must arrive as a bearer
 *   token, so an accidentally exposed port still answers 401.
 * - `SENTRY_DSN` turns error tracking on; unset, every capture is a no-op.
 *   `APP_RELEASE` (a commit SHA or an image tag) and `SENTRY_ENVIRONMENT`
 *   (defaults to `NODE_ENV`) label every event; `SENTRY_TRACES_SAMPLE_RATE`
 *   is 0 by default (errors only, no performance traces).
 */
@Injectable()
@ConfigDomain({ owner: 'Monitoring', feature: 'Configuration', version: '2.0.0', description: 'MonitoringConfig Domain' })
export class MonitoringConfig {
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('METRICS_ENABLED')
  readonly metricsEnabled: boolean = true;

  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'metricsToken must be at least 16 characters' })
  @IsNotPlaceholder()
  @StringFromEnv()
  @EnvVariable('METRICS_TOKEN')
  readonly metricsToken?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/\S+$/, { message: 'sentryDsn must be the https DSN from the Sentry project settings' })
  @IsNotPlaceholder()
  @StringFromEnv()
  @EnvVariable('SENTRY_DSN')
  readonly sentryDsn?: string;

  @IsOptional()
  @IsString()
  @StringFromEnv()
  @EnvVariable('SENTRY_ENVIRONMENT')
  readonly sentryEnvironment?: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  @NumberFromEnv()
  @EnvVariable('SENTRY_TRACES_SAMPLE_RATE')
  readonly sentryTracesSampleRate: number = 0;

  @IsOptional()
  @IsString()
  @StringFromEnv()
  @EnvVariable('APP_RELEASE')
  readonly appRelease?: string;

  get errorTrackingEnabled(): boolean {
    return typeof this.sentryDsn === 'string' && this.sentryDsn.trim() !== '';
  }
}

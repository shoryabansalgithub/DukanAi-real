import { Injectable } from '@nestjs/common';
import { IsEnum, IsInt, IsString, Max, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv, StringFromEnv } from '../hydrate-from-env';
import { IsTrustProxySetting } from '../../common/http/trust-proxy';
import { IsUrlList } from '../validation/env-rules';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Process-level settings. Hydrated with `hydrateFromEnv`. `NODE_ENV` has no
 * default on purpose: a process that does not say which environment it is
 * refuses to boot instead of quietly running as development (which used to
 * load the development template and its settings). The start scripts pin it.
 */
@Injectable()
@ConfigDomain({ owner: 'App', feature: 'Configuration', version: '2.0.0', description: 'AppConfig Domain' })
export class AppConfig {
  @IsEnum(Environment, { message: 'NODE_ENV must be set to development, test or production' })
  @StringFromEnv()
  @EnvVariable('NODE_ENV')
  readonly nodeEnv: Environment;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IntegerFromEnv()
  @EnvVariable('PORT')
  readonly port: number = 3002;

  /** Comma-separated browser origins allowed by CORS and the WebSocket adapter. */
  @IsString()
  @IsUrlList()
  @StringFromEnv()
  @EnvVariable('FRONTEND_URL')
  readonly frontendUrl: string;

  /**
   * Express `trust proxy` setting (see `common/http/trust-proxy.ts`): `false`
   * trusts no proxy, a number is the hop count, or named ranges / IPs / CIDRs.
   * Decides what `req.ip` is, and with it whom the rate limiter counts.
   */
  @IsString()
  @IsTrustProxySetting()
  @StringFromEnv()
  @EnvVariable('TRUST_PROXY')
  readonly trustProxy: string = 'false';

  /**
   * Deployment settings (roadmap 7.3). Shutdown: on SIGTERM/SIGINT the
   * readiness probe answers 503 at once, the process waits
   * `shutdownDrainDelayMs` for the load balancer to stop routing to it (0 in
   * compose; a few seconds behind a Kubernetes Service), then stops
   * listening, finishes in-flight requests and active jobs, and closes
   * BullMQ, Redis and Prisma. `shutdownTimeoutMs` is the watchdog: a drain
   * still running after it exits 1 so a hung connection cannot keep a
   * terminating instance alive. Keep the orchestrator's grace period above
   * `shutdownDrainDelayMs + shutdownTimeoutMs`.
   */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('SHUTDOWN_TIMEOUT_MS')
  readonly shutdownTimeoutMs: number = 30_000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('SHUTDOWN_DRAIN_DELAY_MS')
  readonly shutdownDrainDelayMs: number = 0;

  /**
   * How long the HTTP server keeps an idle keep-alive connection. Must exceed
   * the idle timeout of the proxy or load balancer in front (60 s on most),
   * or the proxy reuses a connection the server just closed and answers 502.
   */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('HTTP_KEEP_ALIVE_TIMEOUT_MS')
  readonly httpKeepAliveTimeoutMs: number = 65_000;

  /**
   * At boot the process waits this long for every BullMQ queue and worker to
   * open its Redis connection before it starts listening (so a probe that
   * passes means the instance can serve and consume). Past it, boot continues
   * with a warning and readiness reports Redis down until it connects.
   */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('QUEUE_READY_TIMEOUT_MS')
  readonly queueReadyTimeoutMs: number = 30_000;
}

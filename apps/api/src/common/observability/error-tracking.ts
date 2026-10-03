import * as Sentry from '@sentry/node';
import { Logger } from '@nestjs/common';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { errorsTrackedTotal } from './metrics';

export interface ErrorContext {
  correlationId?: string;
  shopId?: string;
  userId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  kind: 'unhandled' | 'prisma' | 'job' | 'startup';
}

/**
 * Error tracking (roadmap 7.6): a process-wide facade over Sentry that is a
 * no-op until `SENTRY_DSN` is set, so tests and local runs never dial out.
 * Every capture is also counted (`errors_tracked_total`) and tagged with the
 * correlation id, shop and route so a Sentry issue can be joined to the JSON
 * log line that carries the same id. Request bodies, headers, cookies and
 * query strings are never sent (`dataCollection` switches them off).
 */
export class ErrorTracking {
  private static enabled = false;
  private static readonly logger = new Logger(ErrorTracking.name);

  static init(config: MonitoringConfig, nodeEnv: string | undefined): void {
    if (!config.errorTrackingEnabled) {
      ErrorTracking.enabled = false;
      return;
    }
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.sentryEnvironment ?? nodeEnv ?? 'unknown',
      release: config.appRelease,
      tracesSampleRate: config.sentryTracesSampleRate,
      // Never ship request data: bodies carry customer details, headers the
      // bearer token. An event is the stack plus the tags set in `capture`.
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    });
    ErrorTracking.enabled = true;
    ErrorTracking.logger.log(`Error tracking on (environment=${config.sentryEnvironment ?? nodeEnv}, release=${config.appRelease ?? 'unset'})`);
  }

  static get isEnabled(): boolean {
    return ErrorTracking.enabled;
  }

  /** Hands an error to the tracker with its context; never throws. */
  static capture(error: unknown, context: ErrorContext): void {
    errorsTrackedTotal.inc({ kind: context.kind });
    if (!ErrorTracking.enabled) return;
    try {
      Sentry.withScope((scope) => {
        if (context.correlationId) scope.setTag('correlationId', context.correlationId);
        if (context.shopId) scope.setTag('shopId', context.shopId);
        if (context.route) scope.setTag('route', context.route);
        if (context.method) scope.setTag('method', context.method);
        if (context.statusCode !== undefined) scope.setTag('statusCode', String(context.statusCode));
        scope.setTag('kind', context.kind);
        if (context.userId) scope.setUser({ id: context.userId });
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (captureError) {
      ErrorTracking.logger.warn(`Error tracking capture failed: ${(captureError as Error).message}`);
    }
  }

  /** Flushes pending events (shutdown); resolves within the timeout either way. */
  static async flush(timeoutMs = 2_000): Promise<void> {
    if (!ErrorTracking.enabled) return;
    await Sentry.flush(timeoutMs).catch(() => undefined);
  }
}

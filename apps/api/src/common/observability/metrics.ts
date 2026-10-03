import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The process-wide Prometheus registry and every application metric
 * (roadmap 7.6). Metrics are module-level objects, like prom-client intends:
 * a service records by importing the metric, no injection needed, and
 * `GET /api/metrics` renders this registry. Labels stay low-cardinality
 * (route patterns, status classes, queue names), never ids.
 */
export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: 'dukaanai-api' });
collectDefaultMetrics({ register: metricsRegistry, prefix: 'dukaanai_' });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests answered, by method, route pattern and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds, by method and route pattern.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** `POST /billing/invoice` end to end (replay, completed sale or rejection). */
export const checkoutDurationSeconds = new Histogram({
  name: 'checkout_duration_seconds',
  help: 'Checkout (BillingService.createInvoice) latency in seconds, by outcome.',
  labelNames: ['outcome'] as const,
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const ledgerPostingFailuresTotal = new Counter({
  name: 'ledger_posting_failures_total',
  help: 'Ledger postings that threw (unbalanced entries, lock or write failures), by source type.',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
});

/** Age of the oldest row still waiting in the outbox, 0 when nothing waits. */
export const outboxOldestPendingAgeSeconds = new Gauge({
  name: 'outbox_oldest_pending_age_seconds',
  help: 'Seconds since the oldest PENDING or CLAIMED outbox row was created (0 when none).',
  registers: [metricsRegistry],
});

export const outboxRows = new Gauge({
  name: 'outbox_rows',
  help: 'Outbox rows by status.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const queueJobs = new Gauge({
  name: 'queue_jobs',
  help: 'BullMQ jobs per queue and state (waiting, active, delayed, failed).',
  labelNames: ['queue', 'state'] as const,
  registers: [metricsRegistry],
});

export const retentionRowsPurgedTotal = new Counter({
  name: 'retention_rows_purged_total',
  help: 'Rows removed by the retention sweep, by table.',
  labelNames: ['table'] as const,
  registers: [metricsRegistry],
});

export const errorsTrackedTotal = new Counter({
  name: 'errors_tracked_total',
  help: 'Unhandled or server-side errors handed to error tracking, by kind.',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

/** Status label as the code, e.g. "503"; everything a route answers is counted. */
export function statusLabel(statusCode: number): string {
  return String(Number.isFinite(statusCode) ? statusCode : 0);
}

/** Collapses a matched Express route into its pattern (`/api/products/:id`), or marks the unmatched case. */
export function routeLabel(baseUrl: string | undefined, routePath: string | string[] | undefined): string {
  if (!routePath) return 'unmatched';
  const pattern = Array.isArray(routePath) ? routePath[0] : routePath;
  return `${baseUrl ?? ''}${pattern}`.replace(/\/+$/, '') || '/';
}

import { collectDefaultMetrics, Counter, Gauge, Histogram, LabelValues, Registry } from 'prom-client';

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
  help: 'BullMQ jobs per queue and state (waiting, active, delayed, failed); waiting includes the jobs of a paused queue.',
  labelNames: ['queue', 'state'] as const,
  registers: [metricsRegistry],
});

/** 1 while a BullMQ queue is paused (no worker takes its jobs; the pause is kept in Redis across restarts), else 0. */
export const queuePaused = new Gauge({
  name: 'queue_paused',
  help: 'Whether the BullMQ queue is paused: 1 paused (its jobs wait, counted as waiting), 0 running.',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});

/** Unix time of the last successful backup job of each kind, read from BACKUP_STATUS_DIR on every scrape (roadmap 9.4). */
export const backupLastSuccessTimestampSeconds = new Gauge({
  name: 'backup_last_success_timestamp_seconds',
  help: 'Unix time of the last successful backup job by kind (dump, binlog, documents, offsite), from the <kind>.last-success files in BACKUP_STATUS_DIR',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

/** Financial reconciliation runs (roadmap 9.5), by outcome: clean, drift or failed. */
export const reconciliationRunsTotal = new Counter({
  name: 'reconciliation_runs_total',
  help: 'Financial reconciliation runs by outcome (clean, drift, failed), nightly and on demand.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/** Drifts found by reconciliation runs, by check (documents, postings, tenders, shifts, stock, ledger, dashboard). */
export const reconciliationDriftTotal = new Counter({
  name: 'reconciliation_drift_total',
  help: 'Drifts found by financial reconciliation runs, by check.',
  labelNames: ['check'] as const,
  registers: [metricsRegistry],
});

/** Shops whose most recent reconciliation run found drift or failed; read from the database on every scrape. */
export const reconciliationShopsWithDrift = new Gauge({
  name: 'reconciliation_shops_with_drift',
  help: 'Shops whose latest financial reconciliation run ended in DRIFT or FAILED (0 when every shop is clean).',
  registers: [metricsRegistry],
});

/** Unix time of the most recent finished reconciliation run across every shop; no series until one has run. */
export const reconciliationLastRunTimestampSeconds = new Gauge({
  name: 'reconciliation_last_run_timestamp_seconds',
  help: 'Unix time the most recent financial reconciliation run finished, across every shop.',
  registers: [metricsRegistry],
});

/**
 * Whether the API reached each dependency during the last scrape (roadmap
 * 9.18): 1 up, 0 down. Probed with the readiness timeout on every scrape, so
 * an outage of the database or Redis names its cause instead of surfacing only
 * as a failed readiness probe.
 */
export const dependencyUp = new Gauge({
  name: 'dependency_up',
  help: 'Whether the API reached the dependency (database, redis) on the last scrape: 1 up, 0 down.',
  labelNames: ['dependency'] as const,
  registers: [metricsRegistry],
});

/** Free and total bytes of the volumes the API writes to (documents, upload temp), from statfs on every scrape (roadmap 9.18). */
export const storageVolumeFreeBytes = new Gauge({
  name: 'storage_volume_free_bytes',
  help: 'Bytes available to the API on the volume holding the storage root (volume="storage") and the upload temp directory (volume="uploads").',
  labelNames: ['volume'] as const,
  registers: [metricsRegistry],
});
export const storageVolumeSizeBytes = new Gauge({
  name: 'storage_volume_size_bytes',
  help: 'Total bytes of the volume holding the storage root (volume="storage") and the upload temp directory (volume="uploads").',
  labelNames: ['volume'] as const,
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

/**
 * Outbound email by purpose (invitation, password_reset, password_changed)
 * and outcome: `sent` (the relay accepted it), `failed` (the relay refused
 * or was unreachable), `logged` (no SMTP_URL, written to the log instead).
 * A failed reset link is invisible to the user by design (the answer never
 * says whether an account exists), so this is how anyone learns of it.
 */
export const emailMessagesTotal = new Counter({
  name: 'email_messages_total',
  help: 'Outbound email messages by purpose and outcome (sent, failed, logged).',
  labelNames: ['purpose', 'outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Always 1, labelled with the release this process runs (`APP_RELEASE`: the
 * version tag a release image is built for, or `sha-<commit>`; roadmap 9.21),
 * so a graph or an incident can say which build answered. One series per
 * running release.
 */
export const buildInfo = new Gauge({
  name: 'build_info',
  help: 'Always 1, labelled with the release the API runs (APP_RELEASE, "unknown" when unset).',
  labelNames: ['release'] as const,
  registers: [metricsRegistry],
});

/**
 * Creates each labelled series at 0 (roadmap 9.22). A labelled counter has no
 * series until its first event, which then starts it at 1, and increase() sees
 * no change in a series whose first sample is already 1: an alert on
 * `increase(...) > 0` missed the first failure of each kind after every start
 * (found walking DukaanAiLedgerPostingFailures: one refused sale, no page).
 * The module that owns a label's values calls this at load, before anything
 * can count, for every value an alert can match; adding 0 never resets a count.
 * `alerted-series.spec.ts` fails when an alerted counter lacks its zero series.
 */
export function zeroSeries<T extends string>(counter: Counter<T>, labelSets: ReadonlyArray<LabelValues<T>>): void {
  for (const labels of labelSets) counter.inc(labels, 0);
}

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

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Counter } from 'prom-client';
// The modules that own the label values of the alerted counters create their series at load.
import { LEDGER_SOURCE_TYPES } from '../../ledger/ledger-posting.service';
import { EMAIL_OUTCOMES, EMAIL_PURPOSES } from '../email/email.service';
import { ERROR_KINDS } from './error-tracking';
import { emailMessagesTotal, errorsTrackedTotal, ledgerPostingFailuresTotal, metricsRegistry, zeroSeries } from './metrics';

/**
 * An alert that reads a counter with increase() or rate() sees nothing of a
 * series' first event unless that series already existed at 0: a series born
 * by its first event starts at 1, and increase() over samples that are all 1
 * is 0. Walking DukaanAiLedgerPostingFailures found it (roadmap 9.22): the
 * first refused sale after a start never paged. Every label value such an
 * alert matches must have its series at 0 before anything has counted.
 * Rates over sustained traffic are exempt, with the reason.
 */
const EXEMPT: Record<string, string> = {
  http_requests_total: 'DukaanAiHigh5xxRate (1 % of the answers for 5 minutes) and DukaanAiCredentialFlood (0.1 refusals a second for 10 minutes) read sustained traffic; one first sample cannot decide either',
  checkout_duration_seconds_bucket: 'DukaanAiCheckoutSlow is the p95 of 10 minutes of checkouts',
};
// Added by Prometheus at scrape time, never by the API.
const TARGET_LABELS = new Set(['job', 'instance']);

const RULES = readFileSync(join(resolve(__dirname, '../../../../../deploy'), 'prometheus', 'alerts.yml'), 'utf8');
const EXPRS = [...RULES.matchAll(/expr:\s*(\|?)\n?([\s\S]*?)(?=\n\s+for:|\n\s+keep_firing_for:|\n\s+labels:)/g)].map((m) => m[2].replace(/\n/g, ' '));

interface CounterRead {
  metric: string;
  /** label -> the literal values the matcher accepts (`=` or an alternation under `=~`). */
  labels: Map<string, string[]>;
  expr: string;
}

function countersReadByAlerts(): CounterRead[] {
  const reads: CounterRead[] = [];
  for (const expr of EXPRS) {
    for (const call of expr.matchAll(/\b(?:increase|rate)\(\s*([a-z_:][a-z0-9_:]*)\s*(?:\{([^}]*)\})?\s*\[/g)) {
      const labels = new Map<string, string[]>();
      for (const [, label, op, value] of (call[2] ?? '').matchAll(/([a-z_][a-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)) {
        if (TARGET_LABELS.has(label)) continue;
        if (op === '=') labels.set(label, [value]);
        else if (op === '=~' && /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/.test(value)) labels.set(label, value.split('|'));
      }
      reads.push({ metric: call[1], labels, expr });
    }
  }
  return reads;
}

async function series(counter: Counter<string>): Promise<Array<{ labels: Record<string, string | number>; value: number }>> {
  return (await counter.get()).values.map((v) => ({ labels: v.labels as Record<string, string | number>, value: v.value }));
}

describe('alerted counters exist at 0 before their first event (roadmap 9.22)', () => {
  const reads = countersReadByAlerts();

  it('finds the counters the alert rules read with increase() or rate()', () => {
    const metrics = new Set(reads.map((r) => r.metric));
    expect([...metrics]).toEqual(expect.arrayContaining(['ledger_posting_failures_total', 'email_messages_total', 'errors_tracked_total', 'http_requests_total']));
    for (const exempt of Object.keys(EXEMPT)) expect(metrics.has(exempt)).toBe(true);
  });

  it('every label value an alert matches has its series at 0 at start-up, unless the metric is exempt with a reason', async () => {
    for (const read of reads) {
      if (EXEMPT[read.metric]) continue;
      const metric = metricsRegistry.getSingleMetric(read.metric) as Counter<string> | undefined;
      if (!metric) throw new Error(`alerts.yml reads ${read.metric}, which the API does not register: ${read.expr}`);
      const present = await series(metric);
      if (present.length === 0) throw new Error(`${read.metric} has no series until its first event, so increase() misses that event: zero it with zeroSeries() (${read.expr})`);
      for (const [label, values] of read.labels) {
        for (const value of values) {
          const zero = present.find((s) => s.labels[label] === value && s.value === 0);
          if (!zero) throw new Error(`${read.metric}{${label}="${value}"} is not created at 0 at start-up, so the alert misses its first event: ${read.expr}`);
        }
      }
    }
  });

  it('every ledger source, email purpose and outcome, and error kind has its series', async () => {
    const ledger = await series(ledgerPostingFailuresTotal);
    for (const source of LEDGER_SOURCE_TYPES) expect(ledger).toContainEqual({ labels: { source }, value: 0 });
    const email = await series(emailMessagesTotal);
    for (const purpose of EMAIL_PURPOSES) for (const outcome of EMAIL_OUTCOMES) expect(email).toContainEqual({ labels: { purpose, outcome }, value: 0 });
    const errors = await series(errorsTrackedTotal);
    for (const kind of ERROR_KINDS) expect(errors).toContainEqual({ labels: { kind }, value: 0 });
  });

  it('the first event then moves a series 0 -> 1, and zeroing again never resets a count', async () => {
    ledgerPostingFailuresTotal.inc({ source: 'SALE' });
    expect(await series(ledgerPostingFailuresTotal)).toContainEqual({ labels: { source: 'SALE' }, value: 1 });
    zeroSeries(ledgerPostingFailuresTotal, [{ source: 'SALE' }]);
    expect(await series(ledgerPostingFailuresTotal)).toContainEqual({ labels: { source: 'SALE' }, value: 1 });
  });
});

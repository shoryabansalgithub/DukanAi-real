import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * The Grafana dashboards and the alert rules may only name metrics the API
 * registers (roadmap 9.10): a renamed metric fails here, not as an empty
 * panel in an incident. Series Prometheus or the blackbox exporter produce
 * on their own are listed explicitly.
 */
const DEPLOY = resolve(__dirname, '../../../../../deploy');
const METRICS_SOURCE = readFileSync(join(__dirname, 'metrics.ts'), 'utf8');
const REGISTERED = new Set([...METRICS_SOURCE.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]));
const EXTERNAL = new Set(['up', 'probe_success', 'probe_duration_seconds', 'probe_ssl_earliest_cert_expiry', 'probe_http_status_code', 'vector']);
// Keywords, and the aggregation operators, which may be written `sum by (le) (...)` with the paren after the grouping.
const PROMQL_WORDS = new Set(['by', 'on', 'ignoring', 'without', 'group_left', 'group_right', 'and', 'or', 'unless', 'offset', 'bool', 'le', 'time', 'inf', 'nan', 'sum', 'min', 'max', 'avg', 'count', 'topk', 'bottomk', 'stddev', 'stdvar', 'count_values', 'quantile', 'group']);
const HISTOGRAM_SUFFIX = /_(bucket|count|sum)$/;

function metricsIn(expr: string): string[] {
  // Drop label matchers, ranges, strings and the label lists of `by (...)` / `without (...)` / `on (...)` / `ignoring (...)`.
  const noLabels = expr
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  const names: string[] = [];
  for (const match of noLabels.matchAll(/\b([a-z_][a-z0-9_]*)\b\s*(\()?/g)) {
    const [, name, call] = match;
    if (call || PROMQL_WORDS.has(name) || /^\d/.test(name) || name.startsWith('$')) continue;
    names.push(name.replace(HISTOGRAM_SUFFIX, ''));
  }
  return names;
}

function assertKnown(where: string, expr: string): void {
  for (const name of metricsIn(expr)) {
    if (!REGISTERED.has(name) && !EXTERNAL.has(name)) {
      throw new Error(`${where} uses metric "${name}", which the API does not register (metrics.ts) and Prometheus does not provide: ${expr}`);
    }
  }
}

describe('monitoring assets name only metrics the API exposes', () => {
  it('registers the metrics the roadmap dashboards rely on', () => {
    for (const name of ['checkout_duration_seconds', 'http_requests_total', 'outbox_oldest_pending_age_seconds', 'queue_jobs', 'backup_last_success_timestamp_seconds']) {
      expect(REGISTERED.has(name)).toBe(true);
    }
  });

  it('every Prometheus panel of every Grafana dashboard queries a registered metric through the provisioned data sources', () => {
    const dir = join(DEPLOY, 'grafana', 'dashboards');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    let prometheusPanels = 0;
    for (const file of files) {
      const dashboard = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { uid: string; panels: Array<{ type: string; title: string; datasource?: { uid: string }; targets?: Array<{ expr: string }> }> };
      expect(dashboard.uid).toMatch(/^dukaanai-/);
      for (const panel of dashboard.panels) {
        if (panel.type === 'row') continue;
        expect(['prometheus', 'loki']).toContain(panel.datasource?.uid);
        for (const target of panel.targets ?? []) {
          expect(target.expr.length).toBeGreaterThan(0);
          if (panel.datasource?.uid === 'prometheus') {
            prometheusPanels += 1;
            assertKnown(`${file} › ${panel.title}`, target.expr);
          }
        }
      }
    }
    expect(prometheusPanels).toBeGreaterThan(15);
  });

  it('every alert rule expression uses a registered or probe metric', () => {
    const rules = readFileSync(join(DEPLOY, 'prometheus', 'alerts.yml'), 'utf8');
    const exprs = [...rules.matchAll(/expr:\s*(\|?)\n?([\s\S]*?)(?=\n\s+for:|\n\s+keep_firing_for:|\n\s+labels:)/g)].map((m) => m[2].replace(/\n/g, ' '));
    expect(exprs.length).toBeGreaterThanOrEqual(15);
    for (const expr of exprs) assertKnown('alerts.yml', expr);
  });

  it('the log dashboard searches by the correlation id the API prints', () => {
    const logs = JSON.parse(readFileSync(join(DEPLOY, 'grafana', 'dashboards', 'dukaanai-logs.json'), 'utf8')) as { templating: { list: Array<{ name: string }> }; panels: Array<{ targets?: Array<{ expr: string }> }> };
    expect(logs.templating.list.map((v) => v.name)).toContain('correlationId');
    const exprs = logs.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));
    expect(exprs.some((e) => e.includes('message_correlationId="$correlationId"'))).toBe(true);
  });
});

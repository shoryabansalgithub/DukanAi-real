// Turns an artillery JSON report (artillery run --output) into the baseline
// table for docs/LOAD_TEST_BASELINE.md and applies the roadmap 5 exit gate.
// The gate is strict: every request of every endpoint answered 2xx (a 4xx
// checkout from a stale token is a failure, not a fast success), no transport
// error (a timeout is a failure), no 5xx, checkout p95 < 500 ms, and the load
// was actually delivered (virtual users created = completed, requests =
// responses, none failed). Usage: node load/summarize.mjs report.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node load/summarize.mjs <artillery-report.json>');
const report = JSON.parse(readFileSync(file, 'utf8'));
const agg = report.aggregate;
const counters = agg.counters ?? {};
const summaries = agg.summaries ?? {};

const endpoints = ['checkout', 'dashboard-summary', 'login'];
const sumWhere = (prefix, predicate = () => true) =>
  Object.entries(counters)
    .filter(([k]) => k.startsWith(prefix) && predicate(k.slice(prefix.length)))
    .reduce((sum, [, v]) => sum + v, 0);

const rows = endpoints.map((name) => {
  const codes = `plugins.metrics-by-endpoint.${name}.codes.`;
  const responses = sumWhere(codes);
  const ok = sumWhere(codes, (c) => Number(c) >= 200 && Number(c) < 300);
  const fiveXx = sumWhere(codes, (c) => Number(c) >= 500);
  const transport = sumWhere(`plugins.metrics-by-endpoint.${name}.errors.`);
  const attempted = responses + transport;
  const rt = summaries[`plugins.metrics-by-endpoint.response_time.${name}`] ?? {};
  return { name, attempted, ok, errors: attempted - ok, fiveXx, transport, errorRate: attempted ? ((attempted - ok) / attempted) * 100 : 0, p50: rt.median, p95: rt.p95, p99: rt.p99, max: rt.max };
});

const totalRequests = counters['http.requests'] ?? 0;
const totalResponses = counters['http.responses'] ?? 0;
const transportErrors = sumWhere('errors.');
const all5xx = sumWhere('http.codes.', (c) => Number(c) >= 500);
const allNon2xx = sumWhere('http.codes.', (c) => Number(c) < 200 || Number(c) >= 300);
const vusCreated = counters['vusers.created'] ?? 0;
const vusCompleted = counters['vusers.completed'] ?? 0;
const vusFailed = counters['vusers.failed'] ?? 0;
const durationS = (agg.lastCounterAt - agg.firstCounterAt) / 1000;

// Achieved rate over the busiest 10 s windows (the peak phase), from artillery's intermediate periods.
const windows = (report.intermediate ?? []).map((p) => p.counters?.['http.requests'] ?? 0).sort((a, b) => b - a);
const peakWindows = windows.slice(0, Math.max(1, Math.min(5, windows.length)));
const peakRate = peakWindows.length ? peakWindows.reduce((s, v) => s + v, 0) / (peakWindows.length * 10) : 0;

const fmt = (v) => (v === undefined || v === null ? 'n/a' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
console.log(`| Endpoint | Attempted | 2xx | Errors (non-2xx + transport) | of which 5xx | of which transport | Error rate | p50 ms | p95 ms | p99 ms | max ms |`);
console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  console.log(`| ${r.name} | ${r.attempted} | ${r.ok} | ${r.errors} | ${r.fiveXx} | ${r.transport} | ${r.errorRate.toFixed(2)} % | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} |`);
}
console.log('');
console.log(`Total: ${totalRequests} requests, ${totalResponses} responses, ${transportErrors} transport errors, ${allNon2xx} non-2xx, ${all5xx} 5xx over ${durationS.toFixed(0)} s (${(totalRequests / durationS).toFixed(1)} req/s overall, ${peakRate.toFixed(1)} req/s over the busiest ${peakWindows.length} x 10 s windows); virtual users ${vusCreated} created, ${vusCompleted} completed, ${vusFailed} failed.`);

const checkout = rows.find((r) => r.name === 'checkout');
const checks = [
  ['checkout p95 < 500 ms', (checkout?.p95 ?? Number.POSITIVE_INFINITY) < 500],
  ['zero 5xx', all5xx === 0],
  ['zero transport errors (timeouts, resets)', transportErrors === 0],
  ['every response 2xx', allNon2xx === 0 && rows.every((r) => r.errors === 0)],
  ['load delivered (requests = responses, users created = completed, none failed, checkouts attempted)', totalRequests === totalResponses && vusCreated === vusCompleted && vusFailed === 0 && (checkout?.attempted ?? 0) > 0],
];
const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
console.log(`Gate: ${failed.length === 0 ? 'PASS' : 'FAIL'} (checkout p95 ${fmt(checkout?.p95)} ms, 5xx ${all5xx}, transport errors ${transportErrors}, non-2xx ${allNon2xx})${failed.length ? ` - failed: ${failed.join('; ')}` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;

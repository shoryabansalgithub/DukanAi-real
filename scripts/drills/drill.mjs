#!/usr/bin/env node
// Failure drills against a RUNNING deployment (roadmap 9.18). The suites inject
// failures in-process; this injects them into the running system through hook
// commands and records, for each drill: what users saw, what the alerts said,
// the time to recovery and the reconciliation afterwards.
//
//   node scripts/drills/drill.mjs <drill>
//
// Drills:
//   api-kill         a burst of checkouts, the API process killed (SIGKILL) while they are in flight
//   mysql-stop       MySQL stopped for 60 s, then started
//   redis-stop       Redis stopped for 5 minutes, then started
//   storage-full     the documents volume filled to the last byte for 3 minutes, then freed
//   tls-expiry       the edge serves an expired certificate for 3 minutes, then a valid one
//                    (optionally preceded by a near-expiry certificate, DRILL_TLS_WARN_SECONDS)
//   offsite-restore  dump, sales, a chosen sale, more sales, archive + off-site push; then the
//                    database is restored FROM THE OFF-SITE COPY to the second before the chosen sale
//                    and an API is started on it
//
// While a drill runs, the users of one shop work through the public URLs:
//   cashier    one sale at a time; a failed sale is retried with the same body and key every 2 s,
//              which is what the POS Retry button does, until it succeeds
//   owner      the dashboard summary every 5 s
//   web        the login page every 5 s
//   documents  a Smart Capture bill photo every 10 s, retried with the same bill id on failure
//   probe      the readiness route every 2 s (what a load balancer sees)
// and Prometheus (/api/v1/alerts) and Alertmanager (/api/v2/alerts) are read every 10 s.
//
// Environment:
//   DRILL_API_URL, DRILL_WEB_URL      the public origins (through the edge), e.g. https://api.example.com
//   DRILL_PROMETHEUS_URL, DRILL_ALERTMANAGER_URL   optional; without them the alerts are "not observed"
//   DRILL_HOOK                         a command that takes the hook name as its first argument
//                                      (scripts/drills/drill-stack.sh for the local stack), and/or
//   DRILL_HOOK_<NAME>                  one command per hook, e.g. DRILL_HOOK_API_KILL, DRILL_HOOK_MYSQL_STOP,
//                                      DRILL_HOOK_TLS_EXPIRED (names: api-kill, mysql-stop, mysql-start,
//                                      redis-stop, redis-start, storage-fill, storage-free, tls valid|near|expired,
//                                      restore-backup, restore-publish, restore-run, restore-cleanup)
//   DRILL_RESTORED_API_URL             where restore-run serves the restored database (offsite-restore)
//   DRILL_STATE_FILE                   the drill shop's credentials, reused across drills (created on first use)
//   DRILL_OBSERVER_REPORT, DRILL_OBSERVER_STOP_FILE   when a browser observer runs beside the driver
//                                      (apps/web/e2e-drills/drill-observer.spec.ts): its JSON lines, and the
//                                      file the driver creates to stop it; its receipts count as sales, and
//                                      <stop file>.fault, written once the fault is in place, sends it a
//                                      second cashier who opens the POS mid-incident
//   DRILL_EVIDENCE_DIR                 where <drill>-<stamp>.json/.md/.jsonl are written (default <tmp>/dukaanai-drill-evidence)
//   DRILL_HOLD_SECONDS, DRILL_BASELINE_SECONDS (45), DRILL_RECOVERY_TIMEOUT_SECONDS (600),
//   DRILL_SETTLE_MIN_SECONDS (90), DRILL_SETTLE_MAX_SECONDS (420), DRILL_BURST (8), DRILL_BURST_LEAD_MS (150),
//   DRILL_TLS_WARN_SECONDS (0), DRILL_EXPECT_ALERTS (comma list; overrides the drill's own)
//
// Exit 0 when the drill PASSES: every sale exists exactly once (none lost, none duplicated), the
// users recovered within the timeout, every expected alert fired, and reconciliation is CLEAN for
// every business day the drill touched. The evidence is written either way.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const API = (env.DRILL_API_URL ?? '').replace(/\/$/, '');
const WEB = (env.DRILL_WEB_URL ?? '').replace(/\/$/, '');
const PROM = (env.DRILL_PROMETHEUS_URL ?? '').replace(/\/$/, '');
const AM = (env.DRILL_ALERTMANAGER_URL ?? '').replace(/\/$/, '');
const num = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : Number(env[name]));

const DRILLS = {
  'api-kill': {
    title: 'Kill the API during a checkout burst',
    inject: 'api-kill', clear: null, hold: 0, burst: true,
    expect: [],
    design: 'One API replica (roadmap 9.7): the process dies, the restart policy starts a new one. DukaanAiApiDown and DukaanAiEndpointDown wait 2 minutes, so a restart inside that budget pages nobody.',
  },
  'mysql-stop': {
    title: 'Stop MySQL for 60 seconds',
    inject: 'mysql-stop', clear: 'mysql-start', hold: 60,
    expect: [],
    design: 'Every request answers 503 DATABASE_UNAVAILABLE while the database is away (retry-safe; the POS offers Retry); the 2-minute holds of DukaanAiDependencyDown and DukaanAiEndpointDown keep a 60-second outage below the paging threshold.',
  },
  'redis-stop': {
    title: 'Stop Redis for 5 minutes',
    inject: 'redis-stop', clear: 'redis-start', hold: 300,
    expect: ['DukaanAiDependencyDown'],
    design: 'Redis is advisory for sales (stock keys, cache, rate-limit counters fall back in-process, and none of them waits for Redis); readiness reports it down, and DukaanAiDependencyDown pages once, naming Redis, while the readiness probes are held back.',
  },
  'storage-full': {
    title: 'Fill the storage volume',
    inject: 'storage-fill', clear: 'storage-free', hold: 180,
    expect: ['DukaanAiStorageFull'],
    design: 'Sales live in MySQL and continue; documents cannot be written and must be refused cleanly, then accepted again once space is freed.',
  },
  'tls-expiry': {
    title: 'Expire the TLS certificate',
    warn: 'tls near', inject: 'tls expired', clear: 'tls valid', hold: 180,
    expect: ['DukaanAiCertificateExpired'],
    design: 'Browsers refuse an expired certificate outright. The certificate probe (job blackbox-tls) reads it whether or not it verifies: DukaanAiCertificateExpired pages at once, naming the cause, and Alertmanager holds back the DukaanAiEndpointDown of the same address. A certificate inside 14 days of expiry warns after an hour (DukaanAiCertificateExpiring, the near-expiry stage of DRILL_TLS_WARN_SECONDS).',
  },
  'offsite-restore': {
    title: 'Restore the database from the off-site backup to the point before a chosen sale',
    restore: true, expect: [],
    design: 'The nightly dump plus the 5-minute binary-log archive, shipped encrypted off-site, fetched onto an empty volume and rolled forward to one second before the chosen sale.',
  },
};

const drillName = process.argv[2];
const drill = DRILLS[drillName];
if (!drill) {
  console.error(`usage: drill.mjs <${Object.keys(DRILLS).join('|')}>`);
  process.exit(2);
}
if (!API || !WEB) {
  console.error('DRILL_API_URL and DRILL_WEB_URL are required (the public origins through the edge)');
  process.exit(2);
}
const HOLD = num('DRILL_HOLD_SECONDS', drill.hold ?? 0);
const BASELINE = num('DRILL_BASELINE_SECONDS', 45);
const RECOVERY_TIMEOUT = num('DRILL_RECOVERY_TIMEOUT_SECONDS', 600);
const SETTLE_MIN = num('DRILL_SETTLE_MIN_SECONDS', 90);
const SETTLE_MAX = num('DRILL_SETTLE_MAX_SECONDS', 420);
const BURST = num('DRILL_BURST', 8);
const BURST_LEAD_MS = num('DRILL_BURST_LEAD_MS', 150);
const TLS_WARN = num('DRILL_TLS_WARN_SECONDS', 0);
const EXPECT = env.DRILL_EXPECT_ALERTS !== undefined
  ? env.DRILL_EXPECT_ALERTS.split(',').map((s) => s.trim()).filter(Boolean)
  : [...drill.expect, ...(drillName === 'tls-expiry' && TLS_WARN >= 3700 ? ['DukaanAiCertificateExpiring'] : [])];
const EVIDENCE_DIR = env.DRILL_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'dukaanai-drill-evidence');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const BASE = path.join(EVIDENCE_DIR, `${drillName}-${STAMP}`);
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const attemptsLog = fs.createWriteStream(`${BASE}.jsonl`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => (t ? new Date(t).toISOString() : null);
const hhmmss = (t) => (t ? new Date(t).toISOString().slice(11, 19) : '–');
const secs = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);
const log = (msg) => console.log(`${hhmmss(Date.now())} ${msg}`);
const timeline = [];
const mark = (event, detail = '') => {
  timeline.push({ t: Date.now(), event, detail });
  log(`[${event}] ${detail}`);
};

// ---- HTTP -------------------------------------------------------------------------------------
function errorCode(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  const c = e?.cause;
  return c?.code ?? c?.name ?? e?.code ?? e?.name ?? 'ERROR';
}
async function http(method, url, { body, form, token, timeoutMs = 15000, text = false } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const raw = await res.text();
    let json;
    if (!text) { try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; } }
    return { status: res.status, json, raw, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 'ERR', error: errorCode(e), message: String(e?.cause?.message ?? e?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
  }
}
const ok = (r) => typeof r.status === 'number' && r.status >= 200 && r.status < 300;
const answerOf = (r) => (r.status === 'ERR' ? r.error : `${r.status}${r.json?.code ? ` ${r.json.code}` : ''}`);
const messageOf = (r) => (r.status === 'ERR' ? r.message : (Array.isArray(r.json?.message) ? r.json.message.join('; ') : r.json?.message) ?? (r.raw ? r.raw.slice(0, 120) : ''));

// ---- records ----------------------------------------------------------------------------------
const records = [];
function record(persona, r, extra = {}) {
  const rec = { t: Date.now(), persona, ok: ok(r), status: r.status, answer: answerOf(r), message: ok(r) ? '' : messageOf(r), ms: r.ms, ...extra };
  records.push(rec);
  attemptsLog.write(`${JSON.stringify(rec)}\n`);
  return rec;
}

// ---- the shop and its session ------------------------------------------------------------------
const STATE_FILE = env.DRILL_STATE_FILE ?? path.join(EVIDENCE_DIR, 'drill-account.json');
let account;
const session = { access: null, refresh: null, at: 0, refreshing: null, relogins: 0, refreshes: 0 };

async function login() {
  for (;;) {
    const r = await http('POST', `${API}/api/auth/login`, { body: { email: account.email, password: account.password } });
    if (r.status === 201) {
      session.access = r.json.access_token; session.refresh = r.json.refresh_token; session.at = Date.now();
      return;
    }
    log(`login answered ${answerOf(r)}; retrying in 3 s`);
    await sleep(3000);
  }
}
/** One refresh in flight at a time: two parallel refreshes of one token would trip reuse detection. */
function refreshSession() {
  if (session.refreshing) return session.refreshing;
  session.refreshing = (async () => {
    const r = await http('POST', `${API}/api/auth/refresh`, { body: { refresh_token: session.refresh } });
    if (r.status === 201) {
      session.access = r.json.access_token; session.refresh = r.json.refresh_token; session.at = Date.now(); session.refreshes += 1;
    } else if (r.status === 401 || r.status === 400) {
      // The token is gone (consumed by a refresh whose answer was lost, or revoked): sign in again.
      mark('session-ended', `refresh answered ${answerOf(r)}: signing in again`);
      session.relogins += 1;
      await login();
    }
  })().finally(() => { session.refreshing = null; });
  return session.refreshing;
}
async function api(method, p, opts = {}) {
  if (Date.now() - session.at > 10 * 60 * 1000) await refreshSession();
  let r = await http(method, `${API}/api${p}`, { ...opts, token: session.access });
  if (r.status === 401) {
    await refreshSession();
    r = await http(method, `${API}/api${p}`, { ...opts, token: session.access });
  }
  return r;
}

async function ensureAccount() {
  if (fs.existsSync(STATE_FILE)) {
    account = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    await login();
  } else {
    const suffix = randomUUID().slice(0, 8);
    account = { email: `drill-${suffix}@drill.dukaanai.test`, password: `Drill-${suffix}-Owner-Passw0rd!`, price: 20 };
    const reg = await http('POST', `${API}/api/auth/register`, { body: { email: account.email, password: account.password, name: 'Drill Owner', shopName: `Drill shop ${suffix}` } });
    if (reg.status !== 201) throw new Error(`register answered ${answerOf(reg)}: ${messageOf(reg)}`);
    await login();
    const product = await api('POST', '/products', { body: { name: 'Drill tea', sku: `DRILL-${suffix}`, costPrice: 10, sellingPrice: account.price, mrp: 25, wholesalePrice: 15, unit: 'PCS', gstRate: 'ZERO' } });
    if (product.status !== 201) throw new Error(`create product answered ${answerOf(product)}`);
    const item = await api('POST', '/inventory-domain', { body: { productId: product.json.id } });
    if (item.status !== 201) throw new Error(`inventory item answered ${answerOf(item)}`);
    const stock = await api('POST', `/inventory-domain/${item.json.id}/adjust`, { body: { reason: 'OPENING_BALANCE', quantityChange: 100000, notes: 'drill opening stock' } });
    if (stock.status !== 201) throw new Error(`opening stock answered ${answerOf(stock)}`);
    account.productId = product.json.id;
    account.productName = 'Drill tea';
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  }
  const shift = await api('GET', '/shifts/current');
  if (!(shift.status === 200 && shift.json?.id)) {
    const open = await api('POST', '/shifts/open', { body: { openingCash: 0 } });
    if (open.status !== 201) throw new Error(`open shift answered ${answerOf(open)}: ${messageOf(open)}`);
  }
}

// ---- users ------------------------------------------------------------------------------------
const sales = [];
let stopping = false;
let hardDeadline = Infinity;

/** One sale, retried with the same body and key until it is confirmed (the POS Retry button). */
async function sell(tag) {
  const sale = { key: randomUUID(), tag, startedAt: Date.now(), attempts: 0, failures: 0, invoiceId: null, outcome: null, answers: [] };
  sales.push(sale);
  const body = { idempotencyKey: sale.key, items: [{ productId: account.productId, quantity: 1 }], payments: [{ tender: 'CASH', amount: account.price }] };
  for (;;) {
    sale.attempts += 1;
    const r = await api('POST', '/billing/invoice', { body, timeoutMs: 30000 });
    const rec = record('cashier', r, { key: sale.key, tag });
    sale.answers.push(rec.answer);
    if (r.status === 201 || r.status === 200) {
      sale.invoiceId = r.json?.invoice?.id ?? null;
      sale.invoiceNumber = r.json?.invoice?.invoiceNumber ?? null;
      sale.createdAt = r.json?.invoice?.createdAt ?? null;
      sale.confirmedAt = Date.now();
      sale.outcome = sale.failures === 0 ? 'first-try' : r.status === 200 ? 'complete-after-retry' : 'absent-then-created';
      return sale;
    }
    sale.failures += 1;
    if (r.status === 409 && r.json?.code === 'IDEMPOTENCY_KEY_REUSED') { sale.outcome = 'key-reused'; return sale; }
    if (Date.now() > hardDeadline) { sale.outcome = 'unresolved'; return sale; }
    await sleep(2000);
  }
}

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const captures = [];
async function captureBill() {
  const cap = { billId: `DRILL${Date.now()}`, attempts: 0, failures: 0, answers: [], outcome: null };
  captures.push(cap);
  for (;;) {
    cap.attempts += 1;
    const form = new FormData();
    form.append('image', new Blob([JPEG], { type: 'image/jpeg' }), `${cap.billId}.jpg`);
    const r = await api('POST', `/storage/bills/Walk-in/${cap.billId}`, { form });
    const rec = record('documents', r, { billId: cap.billId });
    cap.answers.push(rec.answer);
    if (ok(r)) { cap.outcome = cap.failures === 0 ? 'first-try' : 'stored-after-retry'; return cap; }
    cap.failures += 1;
    if (stopping || Date.now() > hardDeadline) { cap.outcome = 'not-stored'; return cap; }
    await sleep(10000);
  }
}

async function loop(intervalMs, fn) {
  while (!stopping) {
    const t0 = Date.now();
    await fn();
    const wait = intervalMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
}
const personas = {
  cashier: () => loop(3000, () => sell('steady')),
  owner: () => loop(5000, async () => { record('owner', await api('GET', '/dashboard/summary')); }),
  web: () => loop(5000, async () => {
    const r = await http('GET', `${WEB}/login`, { text: true });
    if (ok(r) && !/DukaanAI/.test(r.raw ?? '')) { r.status = 'BODY'; r.error = 'BODY'; r.message = 'login page without the product name'; }
    record('web', r);
  }),
  documents: () => loop(10000, () => captureBill()),
  probe: () => loop(2000, async () => {
    const r = await http('GET', `${API}/api/health/ready`, { timeoutMs: 5000 });
    record('probe', r, r.json?.checks ? { checks: r.json.checks } : {});
  }),
};

// ---- alerts -----------------------------------------------------------------------------------
const alertState = new Map(); // key -> { alert, severity, instance, summary, description, pendingAt, firingAt, resolvedAt, notifiedAt, receivers, inhibited, delivered, heldBy }
const alertsObserved = { prometheus: Boolean(PROM), alertmanager: Boolean(AM), errors: 0 };
function alertKey(labels) {
  return [labels.alertname, labels.instance ?? '', labels.kind ?? '', labels.queue ?? '', labels.check ?? '', labels.volume ?? '', labels.dependency ?? ''].join('|');
}
async function pollAlerts() {
  const now = Date.now();
  if (PROM) {
    const r = await http('GET', `${PROM}/api/v1/alerts`, { timeoutMs: 5000 });
    if (ok(r)) {
      const seen = new Set();
      for (const a of r.json?.data?.alerts ?? []) {
        const k = alertKey(a.labels); seen.add(k);
        const s = alertState.get(k) ?? { alert: a.labels.alertname, severity: a.labels.severity, instance: a.labels.instance ?? a.labels.kind ?? a.labels.queue ?? a.labels.volume ?? a.labels.dependency ?? '', summary: a.annotations?.summary ?? '', description: a.annotations?.description ?? '', pendingAt: null, firingAt: null, resolvedAt: null, notifiedAt: null, receivers: [], before: !drillStarted };
        if (!s.pendingAt) s.pendingAt = Date.parse(a.activeAt) || now;
        if (a.state === 'firing' && !s.firingAt) { s.firingAt = now; mark('alert-firing', `${s.alert} ${s.instance} (${s.severity}): ${s.summary}`); }
        if (a.state === 'pending' && !alertState.has(k)) mark('alert-pending', `${s.alert} ${s.instance}`);
        s.summary = a.annotations?.summary ?? s.summary; s.description = a.annotations?.description ?? s.description;
        s.resolvedAt = null;
        alertState.set(k, s);
      }
      for (const [k, s] of alertState) {
        if (!seen.has(k) && !s.resolvedAt) { s.resolvedAt = now; mark('alert-resolved', `${s.alert} ${s.instance}`); }
      }
    } else alertsObserved.errors += 1;
  }
  if (AM) {
    const r = await http('GET', `${AM}/api/v2/alerts?active=true&silenced=true&inhibited=true`, { timeoutMs: 5000 });
    if (ok(r) && Array.isArray(r.json)) {
      const nameOf = new Map(r.json.map((a) => [a.fingerprint, a.labels?.alertname]));
      for (const a of r.json) {
        const s = alertState.get(alertKey(a.labels));
        if (!s) continue;
        if (!s.notifiedAt) s.notifiedAt = now;
        s.receivers = [...new Set([...(s.receivers ?? []), ...(a.receivers ?? []).map((x) => x.name)])];
        // Held back (inhibited or silenced) in this poll: Alertmanager sends nothing for it then.
        const by = [...(a.status?.inhibitedBy ?? []), ...(a.status?.silencedBy ?? [])];
        if (by.length > 0) {
          s.inhibited = true;
          s.heldBy = [...new Set([...(s.heldBy ?? []), ...by.map((f) => nameOf.get(f) ?? 'a silence')])];
        } else if (a.status?.state === 'active') s.delivered = true;
        s.amState = a.status?.state;
      }
    } else alertsObserved.errors += 1;
  }
}
let drillStarted = false;

// ---- hooks ------------------------------------------------------------------------------------
const hooks = [];
function hookCommand(name) {
  const own = env[`DRILL_HOOK_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`];
  if (own) return own;
  return env.DRILL_HOOK ? `${env.DRILL_HOOK} ${name}` : null;
}
function runHook(name, extraEnv = {}) {
  const cmd = hookCommand(name);
  if (!cmd) throw new Error(`no command for hook "${name}": set DRILL_HOOK or DRILL_HOOK_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const h = { name, cmd, startedAt: started, ms: Date.now() - started, exit: code, output: out.trim().split('\n').slice(-12).join('\n') };
      hooks.push(h);
      log(`hook ${name} exit ${code} in ${secs(h.ms)} s${out.trim() ? `: ${out.trim().split('\n').slice(-1)[0]}` : ''}`);
      resolve(h);
    });
  });
}

// ---- browser observer -------------------------------------------------------------------------
const OBSERVER_REPORT = env.DRILL_OBSERVER_REPORT ?? '';
const OBSERVER_STOP = env.DRILL_OBSERVER_STOP_FILE ?? '';
/** Stops the observer and returns its lines (waits up to 2 minutes for its final "done"). */
async function collectObserver() {
  if (!OBSERVER_REPORT || !OBSERVER_STOP) return null;
  fs.writeFileSync(OBSERVER_STOP, new Date().toISOString());
  const read = () => (fs.existsSync(OBSERVER_REPORT) ? fs.readFileSync(OBSERVER_REPORT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const until = Date.now() + 120000;
  while (Date.now() < until && !read().some((e) => e.kind === 'done')) await sleep(2000);
  const events = read();
  if (!events.some((e) => e.kind === 'done')) mark('observer', 'the browser observer did not finish within 2 minutes');
  return events;
}

// ---- analysis ---------------------------------------------------------------------------------
/** Per persona: the first failure after the fault, the last failure, and the first success after it. */
function outageOf(persona, from) {
  const rs = records.filter((r) => r.persona === persona && r.t >= from);
  const failures = rs.filter((r) => !r.ok);
  if (failures.length === 0) return { persona, requests: rs.length, failures: 0 };
  const first = failures[0].t;
  const last = failures[failures.length - 1].t;
  const back = rs.find((r) => r.ok && r.t > last);
  const answers = {};
  for (const f of failures) answers[f.answer] = (answers[f.answer] ?? 0) + 1;
  const firstOf = {};
  for (const f of failures) if (!firstOf[f.answer]) firstOf[f.answer] = f.message;
  return { persona, requests: rs.length, failures: failures.length, firstFailureAt: first, lastFailureAt: last, recoveredAt: back?.t ?? null, answers, messages: firstOf };
}

const PERSONA_TEXT = {
  cashier: 'Cashier at the POS (POST /billing/invoice, retried with the same key)',
  owner: 'Owner on the dashboard (GET /dashboard/summary)',
  web: 'Anyone opening the web app (GET /login)',
  documents: 'Smart Capture bill photo (POST /storage/bills)',
  probe: 'Load balancer / uptime check (GET /api/health/ready)',
};

function businessDate(t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.DRILL_TIMEZONE ?? 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

async function listSalesSince(from) {
  const items = [];
  const fromDate = businessDate(from);
  for (let skip = 0; ; skip += 100) {
    let r;
    for (let i = 0; i < 10; i++) {
      r = await api('GET', `/billing/invoices?type=SALE&from=${fromDate}&take=100&skip=${skip}`);
      if (r.status === 200) break;
      await sleep(3000);
    }
    if (r.status !== 200) throw new Error(`invoice list answered ${answerOf(r)}`);
    items.push(...r.json.items);
    if (r.json.items.length < 100) break;
  }
  return items.filter((i) => Date.parse(i.createdAt) >= from - 5000);
}

async function reconcile(dates) {
  const runs = [];
  for (const date of dates) {
    let r;
    for (let i = 0; i < 10; i++) {
      r = await api('POST', '/reconciliation/run', { body: { date }, timeoutMs: 120000 });
      if (r.status === 201) break;
      await sleep(3000);
    }
    runs.push({ date, status: r.json?.status ?? answerOf(r), driftCount: r.json?.driftCount ?? null, runId: r.json?.id ?? null,
      checks: (r.json?.checks ?? []).map((c) => `${c.check ?? c.name}: ${c.status}`),
      drifts: (r.json?.checks ?? []).flatMap((c) => (c.drifts ?? []).map((d) => `${c.check ?? c.name}: ${d.subject} ${d.detail ?? ''}`)).slice(0, 20),
      sales: r.json?.summary?.sales?.count ?? null, netSales: r.json?.summary?.netSales ?? null });
  }
  return runs;
}

// ---- the failure drills -----------------------------------------------------------------------
async function runFaultDrill() {
  const started = Date.now();
  hardDeadline = started + (BASELINE + TLS_WARN + HOLD + RECOVERY_TIMEOUT + SETTLE_MAX + 300) * 1000;
  const alertTimer = setInterval(() => { void pollAlerts(); }, 10000);
  await pollAlerts();
  drillStarted = true;
  mark('baseline', `${BASELINE} s of normal trading through ${API} and ${WEB}`);
  const running = Object.entries(personas).map(([, fn]) => fn());
  await sleep(BASELINE * 1000);

  let injectAt = null; let clearAt = null; let warnAt = null;
  let cleared = drill.clear === null;
  const clearFault = async () => {
    if (cleared) return;
    cleared = true;
    clearAt = Date.now();
    mark('clear', drill.clear);
    const h = await runHook(drill.clear);
    if (h.exit !== 0) mark('hook-failed', `${drill.clear}: ${h.output}`);
  };
  const onSignal = async () => { mark('interrupted', 'clearing the fault before exit'); await clearFault(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (drill.warn && TLS_WARN > 0) {
      warnAt = Date.now();
      mark('warn', `${drill.warn} for ${TLS_WARN} s`);
      await runHook(drill.warn);
      await sleep(TLS_WARN * 1000);
    }
    let burst = [];
    if (drill.burst) {
      mark('burst', `${BURST} checkouts started together; the API is killed ${BURST_LEAD_MS} ms later`);
      burst = Array.from({ length: BURST }, () => sell('burst'));
      await sleep(BURST_LEAD_MS);
    }
    injectAt = Date.now();
    mark('inject', drill.inject);
    const h = await runHook(drill.inject);
    if (h.exit !== 0) throw new Error(`the fault hook ${drill.inject} failed: ${h.output}`);
    if (OBSERVER_STOP) fs.writeFileSync(`${OBSERVER_STOP}.fault`, new Date().toISOString());
    if (HOLD > 0) await sleep(HOLD * 1000);
    await clearFault();
    await Promise.all(burst);

    // Recovered: readiness answers 200 and every persona's last three requests succeeded.
    const since = clearAt ?? injectAt;
    const deadline = since + RECOVERY_TIMEOUT * 1000;
    let recovered = false;
    while (Date.now() < deadline) {
      const lastThree = Object.keys(personas).map((p) => records.filter((r) => r.persona === p && r.t > since).slice(-3));
      if (lastThree.every((rs) => rs.length === 3 && rs.every((r) => r.ok))) { recovered = true; break; }
      await sleep(2000);
    }
    mark(recovered ? 'recovered' : 'not-recovered', recovered ? 'every user path answers again' : `still failing ${RECOVERY_TIMEOUT} s after the fault was cleared`);

    // Settle: let the alerts resolve (blackbox probes run every minute).
    const settleFrom = Date.now();
    for (;;) {
      await sleep(10000);
      const elapsed = (Date.now() - settleFrom) / 1000;
      // Alerts that fired must resolve; one that only went pending never paged anybody.
      const open = [...alertState.values()].filter((s) => !s.before && s.firingAt && !s.resolvedAt);
      if (elapsed >= SETTLE_MIN && open.length === 0) break;
      if (elapsed >= SETTLE_MAX) { mark('settle-timeout', `still open: ${open.map((s) => s.alert).join(', ') || 'none'}`); break; }
    }
  } finally {
    await clearFault();
    stopping = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  await Promise.allSettled(running);
  clearInterval(alertTimer);
  await pollAlerts();
  mark('stopped', 'users stopped; verifying');
  return { started, injectAt, clearAt, warnAt };
}

// ---- the restore drill ------------------------------------------------------------------------
async function runRestoreDrill() {
  const restoredUrl = (env.DRILL_RESTORED_API_URL ?? '').replace(/\/$/, '');
  if (!restoredUrl) throw new Error('DRILL_RESTORED_API_URL is required for offsite-restore (where restore-run serves the restored database)');
  const started = Date.now();
  hardDeadline = started + 3600 * 1000;
  const alertTimer = setInterval(() => { void pollAlerts(); }, 10000);
  await pollAlerts();
  drillStarted = true;
  const result = { restoredUrl };
  try {
    mark('backup', 'the dump the restore starts from');
    const b = await runHook('restore-backup');
    if (b.exit !== 0) throw new Error(`restore-backup failed: ${b.output}`);
    const sell2 = async (tag) => { const s = await sell(tag); await sleep(2500); return s; };
    const before = [await sell2('before'), await sell2('before'), await sell2('before')];
    const chosen = await sell2('chosen');
    const after = [await sell2('after'), await sell2('after')];
    result.before = before.map((s) => s.invoiceNumber);
    result.chosen = { invoiceNumber: chosen.invoiceNumber, id: chosen.invoiceId, createdAt: chosen.createdAt };
    result.after = after.map((s) => s.invoiceNumber);
    // A session opened after the dump: on the restored database it never existed.
    const late = await http('POST', `${API}/api/auth/login`, { body: { email: account.email, password: account.password } });
    result.lateToken = late.json?.access_token ?? null;
    const target = new Date(Math.floor(Date.parse(chosen.createdAt) / 1000) * 1000);
    result.targetTime = target.toISOString().replace('T', ' ').slice(0, 19);
    mark('chosen-sale', `${chosen.invoiceNumber} at ${chosen.createdAt}; the restore target is ${result.targetTime} UTC (the second it began)`);
    mark('publish', 'binary-log archive and off-site push');
    const p = await runHook('restore-publish');
    if (p.exit !== 0) throw new Error(`restore-publish failed: ${p.output}`);

    result.decisionAt = Date.now();
    mark('restore', 'fetch the off-site copy onto an empty volume, restore to the target, start an API on it');
    const r = await runHook('restore-run', { DRILL_TARGET_TIME: result.targetTime });
    result.restoreHookMs = r.ms;
    result.restoreOutput = r.output;
    if (r.exit !== 0) throw new Error(`restore-run failed: ${r.output}`);
    // What users see once they are pointed at the restored database.
    const ready = await http('GET', `${restoredUrl}/api/health/ready`);
    record('restored-probe', ready);
    const lateTry = result.lateToken ? await http('GET', `${restoredUrl}/api/dashboard/summary`, { token: result.lateToken }) : null;
    result.lateSession = lateTry ? answerOf(lateTry) : 'not tested';
    const relogin = await http('POST', `${restoredUrl}/api/auth/login`, { body: { email: account.email, password: account.password } });
    if (relogin.status !== 201) throw new Error(`login on the restored API answered ${answerOf(relogin)}`);
    const tok = relogin.json.access_token;
    result.servingAt = Date.now();
    mark('restored-serving', `the restored API answers sign-in ${secs(result.servingAt - result.decisionAt)} s after the decision`);
    const want = new Set([...before, chosen, ...after].map((s) => s.invoiceNumber));
    const listed = [];
    for (let skip = 0; ; skip += 100) {
      const l = await http('GET', `${restoredUrl}/api/billing/invoices?type=SALE&from=${businessDate(started)}&take=100&skip=${skip}`, { token: tok });
      if (l.status !== 200) throw new Error(`invoice list on the restored API answered ${answerOf(l)}`);
      listed.push(...l.json.items);
      if (l.json.items.length < 100) break;
    }
    const numbers = new Set(listed.map((i) => i.invoiceNumber));
    result.presentBefore = result.before.filter((n) => numbers.has(n));
    result.chosenPresent = numbers.has(chosen.invoiceNumber);
    result.presentAfter = result.after.filter((n) => numbers.has(n));
    result.otherDrillSalesListed = [...numbers].filter((n) => !want.has(n)).length;
    mark('verify', `restored copy: ${result.presentBefore.length}/3 earlier sales, chosen sale ${result.chosenPresent ? 'PRESENT' : 'absent'}, ${result.presentAfter.length}/2 later sales`);
    const dates = [...new Set([businessDate(started), businessDate(Date.now())])];
    result.reconciliation = [];
    for (const date of dates) {
      const run = await http('POST', `${restoredUrl}/api/reconciliation/run`, { body: { date }, token: tok, timeoutMs: 120000 });
      result.reconciliation.push({ date, status: run.json?.status ?? answerOf(run), driftCount: run.json?.driftCount ?? null, sales: run.json?.summary?.sales?.count ?? null, netSales: run.json?.summary?.netSales ?? null,
        drifts: (run.json?.checks ?? []).flatMap((c) => (c.drifts ?? []).map((d) => `${c.check ?? c.name}: ${d.subject} ${d.detail ?? ''}`)).slice(0, 20) });
    }
    result.verifiedAt = Date.now();
  } finally {
    if (env.DRILL_KEEP_RESTORED !== '1') await runHook('restore-cleanup');
    clearInterval(alertTimer);
    await pollAlerts();
  }
  return { started, result };
}

// ---- report -----------------------------------------------------------------------------------
function table(rows) {
  if (rows.length === 0) return '';
  const head = Object.keys(rows[0]);
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${head.map((h) => String(r[h] ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
}
function routedTo(s) {
  if (!s.notifiedAt) return s.firingAt ? 'not seen in Alertmanager' : '';
  const to = (s.receivers ?? []).join(', ') || '(no receiver)';
  if (!s.inhibited) return to;
  const by = (s.heldBy ?? []).join(', ') || 'an inhibit rule';
  return s.delivered ? `${to}; held back part of the time by ${by}` : `held back by ${by} (would go to ${to})`;
}
function alertRows(from) {
  return [...alertState.values()].filter((s) => !s.before || (s.resolvedAt && s.resolvedAt >= from)).map((s) => ({
    Alert: s.alert, Severity: s.severity ?? '', Target: s.instance, Pending: hhmmss(s.pendingAt), Firing: hhmmss(s.firingAt), Resolved: hhmmss(s.resolvedAt),
    'Routed to': routedTo(s),
    Summary: s.summary,
  }));
}

async function main() {
  log(`drill ${drillName}: ${drill.title}`);
  await ensureAccount();
  const report = { drill: drillName, title: drill.title, design: drill.design, api: API, web: WEB, startedAt: iso(Date.now()), hooks, timeline, expectAlerts: EXPECT, failures: [] };
  const failures = report.failures;

  if (drill.restore) {
    const { started, result } = await runRestoreDrill();
    report.restore = result;
    report.finishedAt = iso(Date.now());
    if (result.presentBefore?.length !== 3) failures.push(`restored copy lacks earlier sales (${result.presentBefore?.join(', ')})`);
    if (result.chosenPresent) failures.push('the chosen sale is present in the restored copy');
    if (result.presentAfter?.length) failures.push(`later sales present in the restored copy: ${result.presentAfter.join(', ')}`);
    for (const run of result.reconciliation ?? []) if (run.status !== 'CLEAN') failures.push(`reconciliation of ${run.date} on the restored copy is ${run.status}`);
    if (!result.verifiedAt) failures.push('the restore did not complete');
    report.alerts = alertRows(started);
  } else {
    const t = await runFaultDrill();
    const screen = await collectObserver();
    report.finishedAt = iso(Date.now());
    if (screen) {
      report.screen = screen.filter((e) => e.kind !== 'receipt' && e.kind !== 'stored' && e.t >= t.started);
      report.screenStored = screen.filter((e) => e.kind === 'stored' && e.t >= t.started).length;
      report.screenReceipts = screen.filter((e) => e.kind === 'receipt' && e.t >= t.started).map((e) => ({ t: e.t, invoiceId: e.invoiceId, attempts: e.attempts }));
    }
    report.injectAt = iso(t.injectAt); report.clearAt = iso(t.clearAt); report.warnAt = iso(t.warnAt);
    report.holdSeconds = HOLD;
    // Every sale exactly once: what the API confirmed against what the shop's list holds.
    for (const s of sales.filter((x) => x.outcome === 'unresolved' || x.outcome === null)) {
      const r = await api('POST', '/billing/invoice', { body: { idempotencyKey: s.key, items: [{ productId: account.productId, quantity: 1 }], payments: [{ tender: 'CASH', amount: account.price }] } });
      if (r.status === 200 || r.status === 201) { s.invoiceId = r.json.invoice.id; s.outcome = r.status === 200 ? 'complete-after-retry' : 'absent-then-created'; }
    }
    const listed = await listSalesSince(t.started);
    const listedIds = listed.map((i) => i.id);
    const confirmed = [...sales.filter((s) => s.invoiceId).map((s) => s.invoiceId), ...(report.screenReceipts ?? []).map((r) => r.invoiceId).filter(Boolean)];
    const lost = confirmed.filter((id) => !listedIds.includes(id));
    const extra = listedIds.filter((id) => !confirmed.includes(id));
    const dupIds = listedIds.filter((id, i) => listedIds.indexOf(id) !== i);
    const outcomes = {};
    for (const s of sales) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    const burst = sales.filter((s) => s.tag === 'burst').map((s) => ({ key: s.key.slice(0, 8), attempts: s.attempts, outcome: s.outcome, answers: s.answers.join(' > ') }));
    report.sales = { total: sales.length + (report.screenReceipts?.length ?? 0), browserSales: report.screenReceipts?.length ?? 0, confirmed: confirmed.length, listed: listed.length, lost: lost.length, unaccounted: extra.length, duplicated: dupIds.length, outcomes, burst };
    if (lost.length) failures.push(`${lost.length} confirmed sale(s) missing from the invoice list`);
    if (extra.length) failures.push(`${extra.length} invoice(s) in the list that no cashier was told about (duplicates or lost answers)`);
    const unresolved = sales.filter((s) => !s.invoiceId);
    if (unresolved.length) failures.push(`${unresolved.length} sale(s) never confirmed`);
    report.captures = { total: captures.length, outcomes: captures.reduce((m, c) => ({ ...m, [c.outcome]: (m[c.outcome] ?? 0) + 1 }), {}), retried: captures.filter((c) => c.failures > 0).map((c) => ({ billId: c.billId, attempts: c.attempts, outcome: c.outcome, answers: c.answers.join(' > ') })) };
    const notStored = captures.filter((c) => c.outcome === 'not-stored' && c.failures > 0 && c.answers.some((a) => a.startsWith('409')));
    if (notStored.length) failures.push(`${notStored.length} bill photo(s) refused for good after the fault (${notStored[0].answers.slice(-1)[0]})`);

    const from = t.warnAt ?? t.injectAt;
    report.users = Object.keys(personas).map((p) => outageOf(p, from));
    const userRecovered = report.users.map((u) => (u.failures ? u.recoveredAt : null)).filter((x) => x !== null);
    const neverBack = report.users.filter((u) => u.failures && !u.recoveredAt);
    const firstSeen = Math.min(...report.users.filter((u) => u.failures).map((u) => u.firstFailureAt), Infinity);
    report.recovery = {
      firstUserFailureAt: Number.isFinite(firstSeen) ? iso(firstSeen) : null,
      allUsersBackAt: userRecovered.length ? iso(Math.max(...userRecovered)) : null,
      outageSeconds: userRecovered.length && Number.isFinite(firstSeen) ? secs(Math.max(...userRecovered) - firstSeen) : 0,
      fromInjectSeconds: userRecovered.length ? secs(Math.max(...userRecovered) - t.injectAt) : 0,
      fromClearSeconds: userRecovered.length && t.clearAt ? secs(Math.max(...userRecovered) - t.clearAt) : null,
      perPersona: report.users.filter((u) => u.failures).map((u) => ({ persona: u.persona, outageSeconds: u.recoveredAt ? secs(u.recoveredAt - u.firstFailureAt) : null })),
    };
    if (neverBack.length) failures.push(`never recovered: ${neverBack.map((u) => u.persona).join(', ')}`);
    report.session = { refreshes: session.refreshes, relogins: session.relogins };
    report.alerts = alertRows(t.started);
    const dates = [...new Set([businessDate(t.started), businessDate(Date.now())])];
    report.reconciliation = await reconcile(dates);
    for (const run of report.reconciliation) if (run.status !== 'CLEAN') failures.push(`reconciliation of ${run.date} is ${run.status}`);
  }
  for (const name of EXPECT) {
    if (![...alertState.values()].some((s) => s.alert === name && s.firingAt && !s.before)) failures.push(`expected alert ${name} did not fire`);
  }
  report.alertsObserved = alertsObserved;
  report.verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(`${BASE}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${BASE}.md`, markdown(report));
  attemptsLog.end();
  log(`${report.verdict}${failures.length ? `: ${failures.join('; ')}` : ''}`);
  log(`evidence: ${BASE}.json, ${BASE}.md, ${BASE}.jsonl`);
  process.exit(failures.length ? 1 : 0);
}

function markdown(r) {
  const out = [`### ${r.title} (\`${r.drill}\`): ${r.verdict}`, '', `${r.startedAt} to ${r.finishedAt} UTC against ${r.api}. ${r.design}`, ''];
  out.push('**Timeline (UTC)**', '', table(r.timeline.map((e) => ({ Time: hhmmss(e.t), Event: e.event, Detail: e.detail }))), '');
  if (r.restore) {
    const x = r.restore;
    out.push('**What users saw**', '');
    out.push(`- Before the restore the shop had the three earlier sales (${x.before?.join(', ')}), the chosen sale ${x.chosen?.invoiceNumber} and two later ones (${x.after?.join(', ')}).`);
    out.push(`- On the restored database the invoice list shows ${x.presentBefore?.length}/3 earlier sales, the chosen sale ${x.chosenPresent ? 'PRESENT' : 'absent'}, ${x.presentAfter?.length}/2 later sales.`);
    out.push(`- A session opened after the dump answered ${x.lateSession} on the restored API: users who signed in after the restore point sign in again.`);
    out.push('', '**Time to recovery**', '');
    out.push(`- Decision to restore until the restored API answered sign-in: ${secs(x.servingAt - x.decisionAt)} s (fetch from off-site, restore, roll-forward, API start; the hook took ${secs(x.restoreHookMs)} s).`);
    out.push('', '```', (x.restoreOutput ?? '').slice(0, 1500), '```');
    out.push('', '**Reconciliation afterwards (on the restored copy)**', '', table((x.reconciliation ?? []).map((c) => ({ Date: c.date, Status: c.status, Drift: c.driftCount, Sales: c.sales, 'Net sales': c.netSales }))));
  } else {
    out.push('**What users saw**', '');
    const rows = r.users.map((u) => ({
      User: PERSONA_TEXT[u.persona] ?? u.persona,
      Requests: u.requests,
      Failed: u.failures,
      'Answers while failing': u.failures ? Object.entries(u.answers).map(([a, n]) => `${a} x${n}`).join(', ') : 'none',
      'Message shown': u.failures ? Object.entries(u.messages).map(([a, m]) => `${a}: ${m}`).join(' / ').slice(0, 300) : '',
      'Outage (s)': u.failures ? (u.recoveredAt ? secs(u.recoveredAt - u.firstFailureAt) : 'not recovered') : 0,
    }));
    out.push(table(rows), '');
    if (r.screen) {
      const SCREEN = { pos: 'POS', 'pos-opened-mid-incident': 'POS opened during the fault', dashboard: 'Dashboard', capture: 'Smart Capture' };
      out.push('**What the screen showed** (a real browser: a cashier at the POS, a second cashier opening the POS once the fault is in place, the owner on the dashboard, a bill photo saved in Smart Capture)', '');
      out.push(r.screen.length ? table(r.screen.filter((e) => !['ready', 'done'].includes(e.kind)).map((e) => ({ Time: hhmmss(e.t), Screen: SCREEN[e.view] ?? e.view, 'What it said': e.text ?? e.kind, 'Retry offered': e.view === 'pos' && e.kind === 'error' ? (e.retry ? 'yes' : 'no') : '', Screenshot: e.screenshot ?? '' }))) : 'Nothing changed on any screen.');
      out.push('', `Browser sales during the drill: ${r.screenReceipts.length}, the most attempts one needed: ${Math.max(0, ...r.screenReceipts.map((x) => x.attempts ?? 1))}. Bill photos saved in the browser: ${r.screenStored ?? 0}.`, '');
    }
    const s = r.sales;
    out.push(`Sales: ${s.total} started${s.browserSales ? ` (${s.browserSales} in the browser)` : ''}, ${s.confirmed} confirmed, ${s.listed} in the shop's invoice list; lost ${s.lost}, unaccounted ${s.unaccounted}, duplicated ${s.duplicated}. Outcomes: ${Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    if (s.burst.length) out.push('', table(s.burst.map((b) => ({ 'Burst sale': b.key, Attempts: b.attempts, Outcome: b.outcome, Answers: b.answers }))));
    if (r.captures.retried.length) out.push('', table(r.captures.retried.map((c) => ({ 'Bill photo': c.billId, Attempts: c.attempts, Outcome: c.outcome, Answers: c.answers }))));
    out.push('', `Session: ${r.session.refreshes} token refresh(es), ${r.session.relogins} forced sign-in(s).`, '');
    out.push('**Time to recovery**', '');
    const rec = r.recovery;
    out.push(`- First user-visible failure ${hhmmss(Date.parse(rec.firstUserFailureAt))}, every user path answering again ${hhmmss(Date.parse(rec.allUsersBackAt))}: ${rec.outageSeconds} s seen by users.`);
    out.push(`- ${rec.fromInjectSeconds} s after the fault was injected${rec.fromClearSeconds !== null ? `, ${rec.fromClearSeconds} s after it was cleared` : ''}.`);
    out.push('', '**Reconciliation afterwards**', '', table(r.reconciliation.map((c) => ({ Date: c.date, Status: c.status, Drift: c.driftCount, Sales: c.sales, 'Net sales': c.netSales }))));
  }
  out.push('', '**What the alerts said**', '');
  const ar = r.alerts ?? [];
  out.push(ar.length ? table(ar) : (r.alertsObserved.prometheus ? 'No alert went pending or fired.' : 'Alerts were not observed (no DRILL_PROMETHEUS_URL).'));
  out.push('', `Expected to fire: ${r.expectAlerts.length ? r.expectAlerts.join(', ') : 'none'}.`);
  if (r.failures.length) out.push('', '**Failures**', '', ...r.failures.map((f) => `- ${f}`));
  return `${out.join('\n')}\n`;
}

main().catch((e) => {
  console.error(e);
  try { attemptsLog.end(); } catch { /* closing */ }
  process.exit(1);
});

// Roadmap 9.17: a simulated business day against a running deployment.
//
// Executes load/business-day.yml: `shops` shops, each with an owner, a
// manager and `cashiersPerShop` cashiers on their own sessions, billing
// cash, UPI and credit sales with GST and discounts, returns, cancellations,
// repayments, stock receipts through a goods receipt, shift open and close
// and dashboard polling, over `day.hours` hours of shop time compressed into
// `day.minutes` real minutes, with Redis restarted once and one API instance
// killed mid-run through hook commands. Two browser sessions per shop run
// the same through the UI (apps/web/e2e-load/business-day.spec.ts) from the
// state this driver writes.
//
// Every document request carries an idempotency key and is retried with the
// same key on a network failure or an edge error, exactly as the POS web
// does, so the gate can be checked afterwards without database access:
//   - zero 5xx answered by the API (an edge's 502 while the instance is dead
//     is reported separately: the request was never answered by the API);
//   - every idempotency key resolved to exactly one invoice: the API's invoice
//     list of each shop equals the set of invoices this driver (and the UI
//     sessions) confirmed, nothing more (duplicated), nothing less (lost);
//   - the keys in flight when the instance was killed are each complete
//     (the retry was answered 200 with the existing invoice) or absent (the
//     retry created it afterwards), and the reconciliation of row 9.5
//     reports CLEAN for every shop and every business date touched, which is
//     what rules out a partial one.
//
// Environment:
//   BUSINESS_DAY_TARGETS       API origins, comma separated (an LB's one URL,
//                              or two local instances); LOAD_TARGET is the alias
//   BUSINESS_DAY_DATABASE_URL  the stack's database: cashiers and the manager
//                              are seeded directly (there is no route that
//                              creates a user without an emailed invitation),
//                              as the real-auth suite and the exploit replay do
//   BUSINESS_DAY_PLAN          plan file (default load/business-day.yml)
//   BUSINESS_DAY_MINUTES / _SHOPS / _CASHIERS / _UI_SHOPS  plan overrides
//                              (UI_SHOPS: how many shops get browser sessions;
//                              0 = API only, default = every shop)
//   BUSINESS_DAY_WEB_URL       the web origin for the browser sessions
//   BUSINESS_DAY_FORWARD_FOR   1: every shop sends X-Forwarded-For 10.<n>.0.1
//                              (the API honours it under TRUST_PROXY >= 1), so
//                              the production per-address limits see one
//                              address per shop as in life
//   BUSINESS_DAY_CHAOS         0 disables both failures
//   BUSINESS_DAY_CHAOS_REDIS_RESTART / _API_KILL / _API_START
//                              shell commands run at the plan's moments
//   BUSINESS_DAY_KILLED_TARGET index into TARGETS of the instance the kill
//                              command takes down (default: the last)
//   BUSINESS_DAY_STATE_FILE    state for the UI spec (default load/.business-day.state.json)
//   BUSINESS_DAY_REPORT        JSON report (default load/reports/business-day-<stamp>.json;
//                              a .md summary and a .attempts.jsonl log sit next to it)
//   BUSINESS_DAY_UI_REPORT     where the UI spec writes its outcome (default next to the report)
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const stamp = () => randomUUID().slice(0, 8);
const chance = (percent) => Math.random() * 100 < percent;
/** `ReturnReason` of the return DTO: the route takes the enum, not free text. */
const RETURN_REASONS = ['CUSTOMER_CHANGED_MIND', 'CUSTOMER_REQUEST', 'DAMAGED', 'WRONG_ITEM', 'BILLING_ERROR', 'EXPIRED', 'OTHER'];

// ---- plan and configuration -------------------------------------------------
const planFile = env.BUSINESS_DAY_PLAN || join(here, 'business-day.yml');
const plan = yaml.load(readFileSync(planFile, 'utf8'));
const targets = (env.BUSINESS_DAY_TARGETS || env.LOAD_TARGET || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .map((url, index) => ({ index, url, up: true, downSince: null, transitions: [] }));
if (targets.length === 0) throw new Error('BUSINESS_DAY_TARGETS (or LOAD_TARGET) is required, e.g. http://127.0.0.1:3041,http://127.0.0.1:3042');
const cfg = {
  minutes: num(env.BUSINESS_DAY_MINUTES, plan.day.minutes),
  hours: plan.day.hours,
  shops: num(env.BUSINESS_DAY_SHOPS, plan.day.shops),
  cashiers: num(env.BUSINESS_DAY_CASHIERS, plan.day.cashiersPerShop),
  uiShops: num(env.BUSINESS_DAY_UI_SHOPS, num(env.BUSINESS_DAY_SHOPS, plan.day.shops)),
  uiSessions: plan.day.uiSessionsPerShop,
  webUrl: env.BUSINESS_DAY_WEB_URL || '',
  databaseUrl: env.BUSINESS_DAY_DATABASE_URL || '',
  forwardFor: env.BUSINESS_DAY_FORWARD_FOR === '1',
  chaos: env.BUSINESS_DAY_CHAOS !== '0',
  hooks: { redisRestart: env.BUSINESS_DAY_CHAOS_REDIS_RESTART || '', apiKill: env.BUSINESS_DAY_CHAOS_API_KILL || '', apiStart: env.BUSINESS_DAY_CHAOS_API_START || '' },
  killedTarget: num(env.BUSINESS_DAY_KILLED_TARGET, targets.length - 1),
  // How long a document request keeps retrying with the same key before it is left for the
  // end-of-day resolution: longer than the planned outage plus the instance's boot.
  retrySeconds: num(env.BUSINESS_DAY_RETRY_SECONDS, plan.chaos.apiDownSeconds + 60),
};
if (!cfg.webUrl) cfg.uiShops = 0;
const startedAt = new Date();
const runStamp = startedAt.toISOString().replace(/[:.]/g, '').replace(/Z$/, 'Z');
const reportFile = env.BUSINESS_DAY_REPORT || join(here, 'reports', `business-day-${runStamp}.json`);
const summaryFile = reportFile.replace(/\.json$/, '.md');
const attemptsFile = reportFile.replace(/\.json$/, '.attempts.jsonl');
const uiReportFile = env.BUSINESS_DAY_UI_REPORT || reportFile.replace(/\.json$/, '.ui.json');
const stateFile = env.BUSINESS_DAY_STATE_FILE || join(here, '.business-day.state.json');
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(attemptsFile, '');

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const businessDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// ---- targets and HTTP ---------------------------------------------------------
const healthy = () => targets.filter((t) => t.up);
function markTarget(target, up, why) {
  if (target.up === up) return;
  target.up = up;
  target.downSince = up ? null : Date.now();
  target.transitions.push({ at: new Date().toISOString(), up, why });
  log(`target ${target.url} is ${up ? 'UP' : 'DOWN'} (${why})`);
}
async function probe(target) {
  try {
    const res = await fetch(`${target.url}/api/health`, { signal: AbortSignal.timeout(2000) });
    markTarget(target, res.ok, `health ${res.status}`);
  } catch (error) {
    markTarget(target, false, `health: ${error?.cause?.code || error?.name || error}`);
  }
}
let probing = true;
(async () => {
  while (probing) {
    await Promise.all(targets.map(probe));
    await sleep(3000);
  }
})();

const pending = new Map(); // attempt id -> { key, action, actor, target, since }
const counters = { requests: 0, api5xx: 0, edge5xx: 0, networkErrors: 0, rateLimited: 0 };
const api5xxSamples = [];

/** One HTTP attempt. Throws on a network failure; an edge 5xx (no API body) is reported as one too. */
async function attempt(target, method, path, { body, token, address, timeoutMs }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (address) headers['x-forwarded-for'] = address;
  const res = await fetch(`${target.url}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const apiAnswered = res.status < 500 || Boolean(res.headers.get('x-correlation-id')) || (json && typeof json === 'object' && ('statusCode' in json || 'code' in json));
  return { status: res.status, body: json, text, apiAnswered, retryAfter: Number(res.headers.get('retry-after') || 0) };
}

/**
 * A request on behalf of an actor with fail-over and the POS web's retry
 * policy: a network failure, an edge error or a 429 is retried on a healthy
 * target with the SAME body (and so the same idempotency key) up to
 * `retries` times; an API 5xx is counted and, when the request is
 * idempotent, retried the same way. 4xx answers are definitive.
 */
async function call(actor, method, path, body, { action = 'request', key = null, retries = 6, idempotent = true, timeoutMs = 30_000, auth = true, retryMs = cfg.retrySeconds * 1000 } = {}) {
  if (auth) await ensureToken(actor);
  const id = randomUUID();
  const started = Date.now();
  let attempts = 0;
  let networkErrors = 0;
  let last = null;
  // Retries stop once BOTH the attempt count and the time budget are spent: a non-idempotent
  // step passes retries: 0 and gives up at once, a document waits an outage out.
  const exhausted = (n, since) => n > retries && (retries === 0 || Date.now() - since > retryMs);
  for (;;) {
    attempts += 1;
    const target = actor.target.up ? actor.target : healthy()[0] ?? actor.target;
    pending.set(id, { id, key, action, actor: actor.label, target: target.index, since: Date.now() });
    const t0 = Date.now();
    let res;
    try {
      res = await attempt(target, method, path, { body, token: auth ? actor.token : undefined, address: actor.address, timeoutMs });
      counters.requests += 1;
    } catch (error) {
      pending.delete(id);
      counters.requests += 1;
      counters.networkErrors += 1;
      networkErrors += 1;
      recordAttempt({ actor, action, key, target, status: 0, ms: Date.now() - t0, error: error?.cause?.code || error?.name || String(error) });
      void probe(target);
      if (exhausted(attempts, started)) return { status: 0, body: undefined, attempts, networkErrors, outcome: 'unresolved', error: String(error?.cause?.code || error?.name || error) };
      await sleep(Math.min(8000, 1000 * 2 ** (attempts - 1)));
      continue;
    }
    pending.delete(id);
    recordAttempt({ actor, action, key, target, status: res.status, ms: Date.now() - t0, code: res.body?.code });
    last = res;
    if (res.status === 401 && auth && attempts === 1) {
      // Parallel requests of one actor (the four dashboard reads) must share one refresh: a
      // consumed refresh token presented twice is reuse to the API, which ends every session
      // of the account, the browser's included.
      await refreshShared(actor);
      continue;
    }
    if (res.status === 429) {
      counters.rateLimited += 1;
      if (exhausted(attempts, started)) break;
      await sleep(Math.max(1000, (res.retryAfter || 2) * 1000));
      continue;
    }
    if (res.status >= 500) {
      if (res.apiAnswered) {
        counters.api5xx += 1;
        if (api5xxSamples.length < 20) api5xxSamples.push({ at: new Date().toISOString(), actor: actor.label, action, method, path, status: res.status, body: res.text.slice(0, 300) });
        if (!idempotent || exhausted(attempts, started)) break;
      } else {
        counters.edge5xx += 1;
        networkErrors += 1;
        void probe(target);
        if (exhausted(attempts, started)) return { status: res.status, body: res.body, attempts, networkErrors, outcome: 'unresolved', error: `edge ${res.status}` };
      }
      await sleep(Math.min(8000, 1000 * 2 ** (attempts - 1)));
      continue;
    }
    break;
  }
  return { status: last.status, body: last.body, text: last.text, attempts, networkErrors, outcome: last.status < 400 ? 'ok' : 'refused', ms: Date.now() - started };
}

function recordAttempt({ actor, action, key, target, status, ms, error, code }) {
  appendFileSync(attemptsFile, JSON.stringify({ t: new Date().toISOString(), shop: actor.shop?.index ?? null, actor: actor.label, action, key, target: target.index, status, ms, code, error }) + '\n');
}

// ---- actors and sessions ---------------------------------------------------------
const authQueue = [];
let authBusy = false;
/** Credential requests are spaced out (the auth throttlers are tight on a production stack). */
function queued(fn) {
  return new Promise((resolve, reject) => {
    authQueue.push({ fn, resolve, reject });
    void drainAuth();
  });
}
async function drainAuth() {
  if (authBusy) return;
  authBusy = true;
  while (authQueue.length) {
    const { fn, resolve, reject } = authQueue.shift();
    try {
      resolve(await fn());
    } catch (error) {
      reject(error);
    }
    await sleep(150);
  }
  authBusy = false;
}

function actorFor(shop, label, email, password, targetIndex) {
  return { shop, label, email, password, token: null, refreshToken: null, tokenAt: 0, refreshing: null, target: targets[targetIndex % targets.length], address: cfg.forwardFor ? `10.${shop.index}.0.1` : undefined };
}
async function login(actor) {
  const res = await queued(() => call(actor, 'POST', '/auth/login', { email: actor.email, password: actor.password }, { action: 'login', auth: false, retries: 8 }));
  if (res.status !== 201) throw new Error(`login of ${actor.label} answered ${res.status}: ${res.text?.slice(0, 200)}`);
  actor.token = res.body.access_token;
  actor.refreshToken = res.body.refresh_token;
  actor.tokenAt = Date.now();
}
async function refreshOrLogin(actor) {
  if (actor.refreshToken) {
    const res = await queued(() => call(actor, 'POST', '/auth/refresh', { refresh_token: actor.refreshToken }, { action: 'refresh', auth: false, retries: 4 }));
    if (res.status < 300 && res.body?.access_token) {
      actor.token = res.body.access_token;
      actor.refreshToken = res.body.refresh_token ?? actor.refreshToken;
      actor.tokenAt = Date.now();
      return;
    }
  }
  await login(actor);
}
/** One refresh (or re-login) in flight per actor; concurrent callers await the same one. */
function refreshShared(actor) {
  if (!actor.refreshing) {
    actor.refreshing = refreshOrLogin(actor).finally(() => {
      actor.refreshing = null;
    });
  }
  return actor.refreshing;
}
/** Access tokens live 15 minutes: refresh after 12, as the web's session does. */
async function ensureToken(actor) {
  if (!actor.token) return;
  if (actor.refreshing) await actor.refreshing;
  else if (Date.now() - actor.tokenAt > 12 * 60_000) await refreshShared(actor);
}

function expect(res, status, what) {
  if (res.status !== status) throw new Error(`${what} answered ${res.status} (expected ${status}): ${(res.text || JSON.stringify(res.body) || res.error || '').slice(0, 300)}`);
  return res.body;
}

async function seedUsers(shop, users) {
  if (!cfg.databaseUrl) throw new Error('BUSINESS_DAY_DATABASE_URL is required: cashiers and the manager are seeded directly (no route creates a user without an emailed invitation)');
  const require = createRequire(import.meta.url);
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcrypt');
  // The API's URL carries Prisma pool parameters mysql2 does not know; the seed needs the address and the database only.
  const url = new URL(cfg.databaseUrl);
  url.search = '';
  const conn = await mysql.createConnection(url.toString());
  try {
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 4);
      const now = new Date();
      await conn.execute('INSERT INTO User (id, email, password, name, role, shopId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [u.id, u.email, hash, u.name, u.role, shop.shopId, now, now]);
    }
  } finally {
    await conn.end();
  }
}

// ---- setup ------------------------------------------------------------------------
const shops = [];
async function setupShop(index) {
  const s = stamp();
  const shop = { index, suffix: s, name: `Day shop ${index} ${s}`, recentSales: [], sales: [], returns: [], cancellations: [], repayments: [], receipts: [], shiftEvents: [], polls: 0, errors: [] };
  const password = `Day-${s}-Passw0rd!`;
  shop.owner = actorFor(shop, `shop${index}/owner`, `day-owner-${index}-${s}@load.local`, password, index);
  const reg = await queued(() => call(shop.owner, 'POST', '/auth/register', { email: shop.owner.email, password, name: `Owner ${index}`, shopName: shop.name }, { action: 'register', auth: false, retries: 8 }));
  expect(reg, 201, 'register');
  await login(shop.owner);
  const profile = expect(await call(shop.owner, 'GET', '/auth/profile', undefined, { action: 'profile' }), 200, 'profile');
  shop.shopId = profile.shopId;
  shop.ownerId = profile.id;

  // The manager, the counter cashiers and the browser cashier: seeded rows, then real logins.
  const users = [{ id: `day-${s}-manager`, role: 'MANAGER', name: 'Manager', email: `day-manager-${index}-${s}@load.local`, password }];
  for (let c = 1; c <= cfg.cashiers; c++) users.push({ id: `day-${s}-cashier${c}`, role: 'CASHIER', name: `Cashier ${c}`, email: `day-cashier${c}-${index}-${s}@load.local`, password });
  if (index <= cfg.uiShops) users.push({ id: `day-${s}-uicashier`, role: 'CASHIER', name: 'UI cashier', email: `day-uicashier-${index}-${s}@load.local`, password });
  await seedUsers(shop, users);
  shop.manager = actorFor(shop, `shop${index}/manager`, users[0].email, password, index + 1);
  shop.managerId = users[0].id;
  await login(shop.manager);
  shop.cashiers = [];
  for (let c = 1; c <= cfg.cashiers; c++) {
    const actor = actorFor(shop, `shop${index}/cashier${c}`, users[c].email, password, index + c);
    actor.userId = users[c].id;
    await login(actor);
    shop.cashiers.push(actor);
  }
  shop.uiCashier = index <= cfg.uiShops ? { id: `day-${s}-uicashier`, email: users[users.length - 1].email, password } : null;

  // Supplier, warehouse, catalogue with opening stock, customers.
  const phone = (n) => `9${String(index).padStart(2, '0')}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`.slice(0, 10);
  shop.supplierId = expect(await call(shop.owner, 'POST', '/suppliers', { name: `Wholesaler ${index} ${s}`, phone: phone() }, { action: 'supplier', idempotent: false, retries: 2 }), 201, 'supplier').id;
  shop.warehouseId = expect(await call(shop.owner, 'POST', '/warehouse-domain/warehouses', { code: `WH-${index}-${s}`, name: 'Main store', type: 'MAIN', city: 'Bengaluru' }, { action: 'warehouse', idempotent: false, retries: 2 }), 201, 'warehouse').id;
  shop.products = [];
  const catalogue = [...plan.catalogue.products.map((p) => ({ ...p, openingStock: plan.catalogue.openingStock })), { ...plan.catalogue.scarce, scarce: true }];
  for (const [i, p] of catalogue.entries()) {
    const product = expect(await call(shop.owner, 'POST', '/products', { name: p.name, sku: `DAY-${index}-${i + 1}-${s}`, costPrice: p.costPrice, sellingPrice: p.sellingPrice, mrp: p.mrp, wholesalePrice: p.costPrice + 5, unit: p.unit, gstRate: p.gstRate }, { action: 'product', idempotent: false, retries: 2 }), 201, `product ${p.name}`);
    const item = expect(await call(shop.owner, 'POST', '/inventory-domain', { productId: product.id }, { action: 'inventory-item', idempotent: false, retries: 2 }), 201, 'inventory item');
    expect(await call(shop.owner, 'POST', `/inventory-domain/${item.id}/adjust`, { reason: 'OPENING_BALANCE', quantityChange: p.openingStock, notes: 'business day opening stock' }, { action: 'opening-stock', idempotent: false, retries: 2 }), 201, 'opening stock');
    shop.products.push({ id: product.id, name: p.name, sku: product.sku, price: p.sellingPrice, costPrice: p.costPrice, scarce: Boolean(p.scarce), itemId: item.id });
  }
  shop.customers = [];
  for (let c = 1; c <= plan.catalogue.customers.credit; c++) {
    const customer = expect(await call(shop.manager, 'POST', '/customers', { name: `Credit customer ${c} ${s}`, phone: phone(), creditLimit: plan.catalogue.customers.creditLimit }, { action: 'customer', idempotent: false, retries: 2 }), 201, 'credit customer');
    shop.customers.push({ id: customer.id, name: customer.name, credit: true });
  }
  for (let c = 1; c <= plan.catalogue.customers.plain; c++) {
    const customer = expect(await call(shop.manager, 'POST', '/customers', { name: `Walk-in regular ${c} ${s}`, phone: phone() }, { action: 'customer', idempotent: false, retries: 2 }), 201, 'customer');
    shop.customers.push({ id: customer.id, name: customer.name, credit: false });
  }
  // Drawers: every counter cashier and the manager (cancellations and refunds need the actor's shift).
  for (const actor of [shop.manager, ...shop.cashiers]) {
    expect(await call(actor, 'POST', '/shifts/open', { openingCash: plan.shifts.openingCash }, { action: 'shift-open', idempotent: false, retries: 2 }), 201, `shift open ${actor.label}`);
    shop.shiftEvents.push({ actor: actor.label, event: 'open', at: new Date().toISOString() });
  }
  return shop;
}

// ---- the day's actions -----------------------------------------------------------------
const stats = { sales: { created: 0, replayed: 0, refused: 0, unresolved: 0, refusedBy: {}, byTender: { CASH: 0, UPI: 0, CREDIT: 0 }, discounted: 0 }, returns: { created: 0, replayed: 0, refused: 0, unresolved: 0 }, cancellations: { done: 0, refused: 0, unresolved: 0 }, repayments: { done: 0, refused: 0, unresolved: 0, skippedNoBalance: 0 }, receipts: { done: 0, abandoned: 0 }, managerSales: 0, polls: 0, shiftChanges: 0 };
let killWindow = null; // { from, to, target }
let inFlightAtKill = [];
const inKillWindow = () => killWindow && Date.now() >= killWindow.from && (killWindow.to === null || Date.now() <= killWindow.to);

function buildSale(shop, actor, { managerDiscount = false } = {}) {
  const lineCount = randInt(plan.mix.linesPerSale[0], plan.mix.linesPerSale[1]);
  const pool = shop.products.filter((p) => !p.scarce || chance(12));
  const chosen = [];
  while (chosen.length < lineCount && chosen.length < pool.length) {
    const p = pick(pool);
    if (!chosen.includes(p)) chosen.push(p);
  }
  const items = chosen.map((p) => ({ productId: p.id, quantity: randInt(plan.mix.quantityPerLine[0], plan.mix.quantityPerLine[1]) }));
  const body = { items };
  let discount = 'none';
  if (managerDiscount) {
    items[0].discountPercent = plan.mix.managerDiscountPercent;
    discount = `line ${plan.mix.managerDiscountPercent}% (manager)`;
  } else if (chance(plan.mix.discounted)) {
    if (chance(50)) {
      items[0].discountPercent = pick(plan.mix.lineDiscountPercents);
      discount = `line ${items[0].discountPercent}%`;
    } else {
      body.discountType = 'PERCENTAGE';
      body.discountPercentage = plan.mix.invoiceDiscountPercent;
      body.discountReason = 'Regular customer';
      discount = `invoice ${plan.mix.invoiceDiscountPercent}%`;
    }
  }
  const r = Math.random() * 100;
  const tender = r < plan.mix.tender.cash ? 'CASH' : r < plan.mix.tender.cash + plan.mix.tender.upi ? 'UPI' : 'CREDIT';
  let customer = null;
  if (tender === 'CREDIT') customer = pick(shop.customers.filter((c) => c.credit));
  else if (chance(plan.mix.withCustomer)) customer = pick(shop.customers);
  if (customer) body.customerId = customer.id;
  return { body, tender, discount, customer };
}

async function sale(shop, actor, { managerDiscount = false } = {}) {
  const draft = buildSale(shop, actor, { managerDiscount });
  const calc = await call(actor, 'POST', '/billing/calculate', draft.body, { action: 'calculate' });
  if (calc.outcome !== 'ok') {
    stats.sales.refused += 1;
    stats.sales.refusedBy[calc.body?.code ?? `calc-${calc.status}`] = (stats.sales.refusedBy[calc.body?.code ?? `calc-${calc.status}`] ?? 0) + 1;
    return null;
  }
  const total = Number(calc.body.finalTotal);
  const key = randomUUID();
  const body = { idempotencyKey: key, ...draft.body };
  if (draft.tender === 'CASH') body.payments = [{ tender: 'CASH', amount: total, tenderedAmount: Math.ceil(total / 10) * 10 }];
  else if (draft.tender === 'UPI') body.payments = [{ tender: 'UPI', amount: total, reference: `UPI${randInt(100000, 999999)}` }];
  else {
    body.payments = [];
    body.udharAmount = total;
  }
  const atKill = inKillWindow();
  const res = await call(actor, 'POST', '/billing/invoice', body, { action: 'sale', key });
  const record = { shop: shop.index, actor: actor.label, actorId: actor.userId ?? shop.managerId, key, body, tender: draft.tender, discount: draft.discount, total, status: res.status, attempts: res.attempts, networkErrors: res.networkErrors, duringKill: atKill || inKillWindow(), outcome: null, invoiceId: null, invoiceNumber: null, code: res.body?.code ?? null };
  if (res.status === 201 || res.status === 200) {
    record.outcome = res.status === 201 ? 'created' : 'replayed';
    record.invoiceId = res.body.invoice.id;
    record.invoiceNumber = res.body.invoice.invoiceNumber;
    stats.sales[record.outcome] += 1;
    stats.sales.byTender[draft.tender] += 1;
    if (draft.discount !== 'none') stats.sales.discounted += 1;
    if (draft.customer && draft.tender === 'CREDIT') draft.customer.creditSales = (draft.customer.creditSales ?? 0) + 1;
    shop.recentSales.push({ id: record.invoiceId, number: record.invoiceNumber, cashier: actor, tender: draft.tender, items: res.body.invoice.items.map((i) => ({ id: i.id, quantity: Number(i.quantity), returned: 0 })), returned: false, cancelled: false, at: Date.now() });
    if (shop.recentSales.length > 60) shop.recentSales.shift();
  } else if (res.outcome === 'refused') {
    record.outcome = 'refused';
    stats.sales.refused += 1;
    stats.sales.refusedBy[record.code ?? String(res.status)] = (stats.sales.refusedBy[record.code ?? String(res.status)] ?? 0) + 1;
  } else {
    record.outcome = 'unresolved';
    stats.sales.unresolved += 1;
  }
  if (managerDiscount) stats.managerSales += 1;
  shop.sales.push(record);
  return record;
}

async function saleReturn(shop, actor) {
  const candidates = shop.recentSales.filter((s) => s.cashier === actor && !s.cancelled && s.items.some((i) => i.returned < i.quantity));
  if (candidates.length === 0) return null;
  const target = pick(candidates);
  const line = pick(target.items.filter((i) => i.returned < i.quantity));
  const key = randomUUID();
  const body = { idempotencyKey: key, invoiceId: target.id, items: [{ invoiceItemId: line.id, quantity: 1 }], reason: pick(RETURN_REASONS), notes: 'Customer returned one unit', refund: { tender: target.tender === 'UPI' ? 'UPI' : 'CASH' } };
  const res = await call(actor, 'POST', '/billing/returns', body, { action: 'return', key });
  const record = { shop: shop.index, actor: actor.label, actorId: actor.userId, key, body, status: res.status, attempts: res.attempts, duringKill: inKillWindow(), outcome: null, invoiceId: null, originalId: target.id, code: res.body?.code ?? null };
  if (res.status === 201 || res.status === 200) {
    record.outcome = res.status === 201 ? 'created' : 'replayed';
    record.invoiceId = res.body.invoice?.id ?? res.body.id;
    stats.returns[record.outcome] += 1;
    line.returned += 1;
    target.returned = true;
  } else if (res.outcome === 'refused') {
    record.outcome = 'refused';
    stats.returns.refused += 1;
    if (res.body?.code === 'INVOICE_NOT_RETURNABLE') target.cancelled = true;
  } else {
    record.outcome = 'unresolved';
    stats.returns.unresolved += 1;
  }
  shop.returns.push(record);
  return record;
}

async function cancellation(shop) {
  const candidates = shop.recentSales.filter((s) => !s.returned && !s.cancelled && s.cashier !== shop.manager);
  if (candidates.length === 0) return null;
  const target = pick(candidates);
  target.cancelled = true; // nobody else returns it meanwhile
  const res = await call(shop.manager, 'POST', `/billing/invoices/${target.id}/cancel`, { reason: 'Billed in error' }, { action: 'cancel', idempotent: false, retries: 0 });
  const record = { shop: shop.index, actor: shop.manager.label, invoiceId: target.id, status: res.status, duringKill: inKillWindow(), outcome: null, code: res.body?.code ?? null };
  if (res.status === 200 || res.status === 201) {
    record.outcome = 'done';
    stats.cancellations.done += 1;
  } else if (res.outcome === 'refused') {
    record.outcome = 'refused';
    stats.cancellations.refused += 1;
    if (res.body?.code !== 'INVOICE_NOT_CANCELLABLE') target.cancelled = false;
  } else {
    // The answer was lost: the invoice is either CANCELLED or untouched; read it back.
    const read = await call(shop.manager, 'GET', `/billing/invoices/${target.id}`, undefined, { action: 'cancel-verify' });
    if (read.status === 200 && read.body.status === 'CANCELLED') {
      record.outcome = 'done';
      stats.cancellations.done += 1;
    } else if (read.status === 200) {
      record.outcome = 'absent';
      target.cancelled = false;
      stats.cancellations.refused += 1;
    } else {
      record.outcome = 'unresolved';
      stats.cancellations.unresolved += 1;
    }
  }
  shop.cancellations.push(record);
  return record;
}

async function repayment(shop, actor) {
  const withCredit = shop.customers.filter((c) => c.credit && (c.creditSales ?? 0) > 0);
  if (withCredit.length === 0) {
    stats.repayments.skippedNoBalance += 1;
    return null;
  }
  const customer = pick(withCredit);
  const read = await call(actor, 'GET', `/customers/${customer.id}`, undefined, { action: 'customer-read' });
  if (read.status !== 200) return null;
  const outstanding = Number(read.body.outstandingBalance ?? 0);
  if (outstanding <= 0) {
    stats.repayments.skippedNoBalance += 1;
    return null;
  }
  const amount = round2(Math.min(outstanding, rand(100, 2000)));
  const key = randomUUID();
  const body = { idempotencyKey: key, amount, tender: chance(60) ? 'CASH' : 'UPI' };
  const res = await call(actor, 'POST', `/customers/${customer.id}/payments`, body, { action: 'repayment', key });
  const record = { shop: shop.index, actor: actor.label, customerId: customer.id, key, amount, tender: body.tender, status: res.status, attempts: res.attempts, duringKill: inKillWindow(), outcome: null, transactionId: null, code: res.body?.code ?? null };
  if (res.status === 201 || res.status === 200) {
    record.outcome = 'done';
    record.transactionId = res.body.transaction?.id ?? null;
    stats.repayments.done += 1;
  } else if (res.outcome === 'refused') {
    record.outcome = 'refused';
    stats.repayments.refused += 1;
  } else {
    record.outcome = 'unresolved';
    stats.repayments.unresolved += 1;
  }
  shop.repayments.push(record);
  return record;
}

async function stockReceipt(shop, n) {
  const products = [...shop.products].sort(() => Math.random() - 0.5).slice(0, plan.receipts.lines);
  const record = { shop: shop.index, n, outcome: 'done', step: null, purchaseOrderId: null, goodsReceiptId: null, lines: [] };
  const step = async (name, actor, method, path, body) => {
    record.step = name;
    const res = await call(actor, method, path, body, { action: `receipt-${name}`, idempotent: false, retries: 0 });
    if (res.status !== 201 && res.status !== 200) throw new Error(`${name} answered ${res.status}: ${(res.text || res.error || '').slice(0, 200)}`);
    return res.body;
  };
  try {
    const items = products.map((p) => ({ productId: p.id, quantity: randInt(plan.receipts.quantity[0], plan.receipts.quantity[1]), unitCost: p.costPrice }));
    const po = await step('order', shop.owner, 'POST', '/purchases', { supplierId: shop.supplierId, items });
    record.purchaseOrderId = po.id;
    await step('submit', shop.owner, 'POST', `/purchases/${po.id}/submit`, {});
    await step('approve', shop.manager, 'POST', `/purchases/${po.id}/approve`, { comments: 'Approved for receipt' });
    const grn = await step('grn', shop.owner, 'POST', '/grn', {
      purchaseOrderId: po.id,
      supplierId: shop.supplierId,
      warehouseId: shop.warehouseId,
      lines: po.items.map((line) => ({ purchaseOrderItemId: line.id, productId: line.productId, receivedQuantity: Number(line.quantity) })),
    });
    record.goodsReceiptId = grn.id;
    record.lines = grn.lines.map((l) => ({ productId: l.productId, quantity: Number(l.receivedQuantity) }));
    await step('receive', shop.owner, 'POST', `/grn/${grn.id}/receive`, { lines: grn.lines.map((l) => ({ id: l.id, receivedQuantity: Number(l.receivedQuantity) })) });
    await step('inspect', shop.owner, 'POST', `/grn/${grn.id}/inspect`, { status: 'PASS', lines: grn.lines.map((l) => ({ id: l.id, acceptedQuantity: Number(l.receivedQuantity) })) });
    const accepted = await step('accept', shop.owner, 'POST', `/grn/${grn.id}/accept`, {});
    record.status = accepted.status;
    stats.receipts.done += 1;
  } catch (error) {
    record.outcome = 'abandoned';
    record.error = String(error.message || error);
    stats.receipts.abandoned += 1;
  }
  shop.receipts.push(record);
  return record;
}

async function shiftChange(shop, actor) {
  const current = await call(actor, 'GET', '/shifts/current', undefined, { action: 'shift-current' });
  const expected = Number(current.body?.expectedCash ?? plan.shifts.openingCash);
  const closed = await call(actor, 'POST', '/shifts/current/close', { closingCash: round2(expected), notes: 'Mid-day drawer change' }, { action: 'shift-close', idempotent: false, retries: 1 });
  shop.shiftEvents.push({ actor: actor.label, event: 'close', at: new Date().toISOString(), status: closed.status });
  const opened = await call(actor, 'POST', '/shifts/open', { openingCash: plan.shifts.openingCash }, { action: 'shift-open', idempotent: false, retries: 1 });
  shop.shiftEvents.push({ actor: actor.label, event: 'open', at: new Date().toISOString(), status: opened.status });
  stats.shiftChanges += 1;
}

async function closeShift(shop, actor) {
  const current = await call(actor, 'GET', '/shifts/current', undefined, { action: 'shift-current' });
  if (current.status !== 200 || !current.body?.id) return;
  const expected = Number(current.body.expectedCash ?? 0);
  const closed = await call(actor, 'POST', '/shifts/current/close', { closingCash: round2(expected), notes: 'End of day' }, { action: 'shift-close', idempotent: false, retries: 2 });
  shop.shiftEvents.push({ actor: actor.label, event: 'close', at: new Date().toISOString(), status: closed.status });
}

// ---- loops ------------------------------------------------------------------------------
let runStart = 0;
let runEnd = 0;
const fraction = () => Math.min(1, (Date.now() - runStart) / (runEnd - runStart));
const hourMs = () => (cfg.minutes * 60_000) / cfg.hours;
const currentRate = () => plan.profile[Math.min(plan.profile.length - 1, Math.floor(fraction() * cfg.hours))];

async function cashierLoop(shop, actor, { midDayChange }) {
  let changed = false;
  let salesDone = 0;
  while (Date.now() < runEnd) {
    const interval = (hourMs() / currentRate()) * rand(0.7, 1.3);
    await sleep(Math.min(interval, Math.max(0, runEnd - Date.now())));
    if (Date.now() >= runEnd) break;
    try {
      if (midDayChange && !changed && fraction() >= plan.shifts.midDayChangeAt) {
        changed = true;
        await shiftChange(shop, actor);
      }
      await sale(shop, actor);
      salesDone += 1;
      const r = Math.random() * 100;
      const p = plan.mix.perHundredSales;
      if (r < p.returns) await saleReturn(shop, actor);
      else if (r < p.returns + p.repayments) await repayment(shop, actor);
    } catch (error) {
      shop.errors.push({ at: new Date().toISOString(), actor: actor.label, error: String(error.message || error) });
    }
  }
  return salesDone;
}

async function managerLoop(shop) {
  const p = plan.mix.perHundredSales;
  while (Date.now() < runEnd) {
    // The manager acts (p.cancellations + p.managerSales) times per 100 cashier sales of the shop.
    const perSaleInterval = hourMs() / (currentRate() * cfg.cashiers);
    const interval = (perSaleInterval * 100) / (p.cancellations + p.managerSales);
    await sleep(Math.min(interval * rand(0.7, 1.3), Math.max(0, runEnd - Date.now())));
    if (Date.now() >= runEnd) break;
    try {
      if (Math.random() * (p.cancellations + p.managerSales) < p.cancellations) await cancellation(shop);
      else await sale(shop, shop.manager, { managerDiscount: true });
    } catch (error) {
      shop.errors.push({ at: new Date().toISOString(), actor: shop.manager.label, error: String(error.message || error) });
    }
  }
}

async function ownerLoop(shop) {
  const receiptsDue = [...plan.receipts.at];
  let nextPoll = Date.now();
  let nextNotifications = Date.now();
  let nextLists = Date.now() + plan.dashboard.listsEveryMinutes * 60_000;
  while (Date.now() < runEnd) {
    try {
      const now = Date.now();
      if (now >= nextPoll) {
        await Promise.all(['/dashboard/summary', '/dashboard/kpis', '/dashboard/trends?days=30', '/dashboard/insights'].map((path) => call(shop.owner, 'GET', path, undefined, { action: 'dashboard' })));
        shop.polls += 1;
        stats.polls += 1;
        nextPoll = now + plan.dashboard.pollSeconds * 1000;
      }
      if (now >= nextNotifications) {
        await call(shop.owner, 'GET', '/notifications', undefined, { action: 'notifications' });
        nextNotifications = now + plan.dashboard.notificationsSeconds * 1000;
      }
      if (now >= nextLists) {
        await call(shop.owner, 'GET', '/billing/invoices?take=25', undefined, { action: 'invoice-list' });
        await call(shop.owner, 'GET', '/customers?take=25', undefined, { action: 'customer-list' });
        nextLists = now + plan.dashboard.listsEveryMinutes * 60_000;
      }
      if (receiptsDue.length && fraction() >= receiptsDue[0]) {
        receiptsDue.shift();
        await stockReceipt(shop, plan.receipts.at.length - receiptsDue.length);
      }
    } catch (error) {
      shop.errors.push({ at: new Date().toISOString(), actor: shop.owner.label, error: String(error.message || error) });
    }
    await sleep(1000);
  }
}

// ---- chaos ---------------------------------------------------------------------------------
const chaosEvents = [];
function runHook(name, command, { detached = false } = {}) {
  const event = { name, at: new Date().toISOString(), command, ok: null, output: '' };
  chaosEvents.push(event);
  if (!command) {
    event.ok = null;
    event.output = 'no hook command configured: skipped';
    log(`chaos ${name}: no hook command configured, skipped`);
    return event;
  }
  try {
    if (detached) {
      const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
      child.unref();
      event.ok = true;
    } else {
      event.output = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).slice(-500);
      event.ok = true;
    }
    log(`chaos ${name}: ok`);
  } catch (error) {
    event.ok = false;
    event.output = String(error.message || error).slice(-500);
    log(`chaos ${name}: FAILED ${event.output}`);
  }
  return event;
}
async function chaosSchedule() {
  if (!cfg.chaos) return;
  const at = (f) => runStart + f * (runEnd - runStart);
  await sleep(Math.max(0, at(plan.chaos.redisRestartAt) - Date.now()));
  if (Date.now() >= runEnd) return;
  runHook('redis-restart', cfg.hooks.redisRestart);
  await sleep(Math.max(0, at(plan.chaos.apiKillAt) - Date.now()));
  if (Date.now() >= runEnd) return;
  const victim = targets[cfg.killedTarget] ?? targets[targets.length - 1];
  // A checkout burst at the instance about to die (roadmap 9.18 wording): the cashiers pinned to
  // it each start a sale a moment before the kill, so there are documents in flight when the
  // socket drops. Nobody is told the instance is gone: the health probe (every 3 s) and the
  // failed attempts discover it, as a load balancer's health check would.
  const burst = shops.flatMap((shop) => shop.cashiers.filter((c) => c.target === victim)).slice(0, plan.chaos.burstBeforeKill ?? 6);
  const burstRuns = burst.map((actor) => sale(actor.shop, actor).catch((error) => actor.shop.errors.push({ at: new Date().toISOString(), actor: actor.label, error: `burst: ${error.message}` })));
  await sleep(plan.chaos.burstLeadMs ?? 60);
  inFlightAtKill = [...pending.values()].map((p) => ({ ...p, sinceIso: new Date(p.since).toISOString() }));
  killWindow = { from: Date.now(), to: null, target: victim.index };
  runHook('api-kill', cfg.hooks.apiKill);
  log(`${inFlightAtKill.length} request(s) were in flight at the kill (${inFlightAtKill.filter((p) => p.key).length} with an idempotency key, ${burst.length} of them the checkout burst)`);
  void Promise.all(burstRuns);
  await sleep(plan.chaos.apiDownSeconds * 1000);
  runHook('api-start', cfg.hooks.apiStart, { detached: true });
  const until = Date.now() + 120_000;
  while (!victim.up && Date.now() < until) {
    await probe(victim);
    if (!victim.up) await sleep(2000);
  }
  killWindow.to = Date.now();
  chaosEvents.push({ name: 'api-back', at: new Date().toISOString(), ok: victim.up, output: victim.up ? `${victim.url} answers again` : `${victim.url} did not come back within 120 s` });
}

// ---- verification -----------------------------------------------------------------------------
async function listAll(shop, type) {
  const items = [];
  for (let skip = 0; ; skip += 100) {
    const res = await call(shop.owner, 'GET', `/billing/invoices?type=${type}&take=100&skip=${skip}`, undefined, { action: 'verify-list', retries: 10 });
    if (res.status !== 200) throw new Error(`invoice list of shop ${shop.index} answered ${res.status}`);
    items.push(...res.body.items);
    if (res.body.items.length < 100 || items.length >= Number(res.body.total)) break;
  }
  return items;
}

async function resolveUnresolved(shop) {
  // What a cashier does after the screen said "could not reach the server": press the same button again.
  for (const record of shop.sales.filter((s) => s.outcome === 'unresolved')) {
    const actor = [shop.manager, ...shop.cashiers].find((a) => a.label === record.actor);
    const res = await call(actor, 'POST', '/billing/invoice', record.body, { action: 'sale-resolve', key: record.key, retries: 10 });
    if (res.status === 200) {
      record.outcome = 'complete-after-retry';
      record.invoiceId = res.body.invoice.id;
    } else if (res.status === 201) {
      record.outcome = 'absent-then-created';
      record.invoiceId = res.body.invoice.id;
    } else if (res.outcome === 'refused') record.outcome = 'refused-on-retry';
    record.resolveStatus = res.status;
  }
  for (const record of shop.returns.filter((r) => r.outcome === 'unresolved')) {
    const actor = shop.cashiers.find((a) => a.label === record.actor);
    const res = await call(actor, 'POST', '/billing/returns', record.body, { action: 'return-resolve', key: record.key, retries: 10 });
    if (res.status === 200 || res.status === 201) {
      record.outcome = res.status === 200 ? 'complete-after-retry' : 'absent-then-created';
      record.invoiceId = res.body.invoice?.id ?? res.body.id;
    } else if (res.outcome === 'refused') record.outcome = 'refused-on-retry';
    record.resolveStatus = res.status;
  }
  for (const record of shop.repayments.filter((r) => r.outcome === 'unresolved')) {
    const actor = shop.cashiers.find((a) => a.label === record.actor);
    const res = await call(actor, 'POST', `/customers/${record.customerId}/payments`, { idempotencyKey: record.key, amount: record.amount, tender: record.tender }, { action: 'repayment-resolve', key: record.key, retries: 10 });
    if (res.status === 200 || res.status === 201) {
      record.outcome = res.status === 200 ? 'complete-after-retry' : 'absent-then-created';
      record.transactionId = res.body.transaction?.id ?? null;
    } else if (res.outcome === 'refused') record.outcome = 'refused-on-retry';
    record.resolveStatus = res.status;
  }
}

async function verifyShop(shop, ui) {
  const result = { shop: shop.index, shopId: shop.shopId, name: shop.name, checks: [], reconciliation: [] };
  const check = (name, pass, detail) => result.checks.push({ name, pass, detail });

  const driverSaleIds = new Set(shop.sales.filter((s) => s.invoiceId).map((s) => s.invoiceId));
  const uiSaleIds = new Set((ui?.sales ?? []).map((s) => s.invoiceId).filter(Boolean));
  const expectedSales = new Set([...driverSaleIds, ...uiSaleIds]);
  const apiSales = await listAll(shop, 'SALE');
  const apiSaleIds = new Set(apiSales.map((i) => i.id));
  const duplicatedOrUnknown = [...apiSaleIds].filter((id) => !expectedSales.has(id));
  const lost = [...expectedSales].filter((id) => !apiSaleIds.has(id));
  check('every sale key resolved to exactly one invoice', duplicatedOrUnknown.length === 0 && lost.length === 0, `API lists ${apiSaleIds.size} sales; the sessions confirmed ${expectedSales.size} (${driverSaleIds.size} API, ${uiSaleIds.size} UI); unknown or duplicated ${duplicatedOrUnknown.length}, lost ${lost.length}${duplicatedOrUnknown.length ? ` [${duplicatedOrUnknown.slice(0, 5).join(', ')}]` : ''}${lost.length ? ` lost [${lost.slice(0, 5).join(', ')}]` : ''}`);
  const stillUnresolved = [...shop.sales, ...shop.returns, ...shop.repayments].filter((r) => r.outcome === 'unresolved');
  check('no document is left unresolved after the retry', stillUnresolved.length === 0, `${stillUnresolved.length} unresolved`);

  const driverReturnIds = new Set(shop.returns.filter((r) => r.invoiceId).map((r) => r.invoiceId));
  const uiReturnIds = new Set((ui?.returns ?? []).map((r) => r.invoiceId).filter(Boolean));
  const expectedReturns = new Set([...driverReturnIds, ...uiReturnIds]);
  const apiReturns = await listAll(shop, 'SALES_RETURN');
  const apiReturnIds = new Set(apiReturns.map((i) => i.id));
  const extraReturns = [...apiReturnIds].filter((id) => !expectedReturns.has(id));
  const lostReturns = [...expectedReturns].filter((id) => !apiReturnIds.has(id));
  check('every return key resolved to exactly one return document', extraReturns.length === 0 && lostReturns.length === 0, `API lists ${apiReturnIds.size} returns; confirmed ${expectedReturns.size}; unknown ${extraReturns.length}, lost ${lostReturns.length}`);

  const cancelledExpected = new Set([...shop.cancellations.filter((c) => c.outcome === 'done').map((c) => c.invoiceId), ...(ui?.cancellations ?? []).map((c) => c.invoiceId).filter(Boolean)]);
  const cancelledApi = new Set(apiSales.filter((i) => i.status === 'CANCELLED').map((i) => i.id));
  const cancelMismatch = [...cancelledExpected].filter((id) => !cancelledApi.has(id)).length + [...cancelledApi].filter((id) => !cancelledExpected.has(id)).length;
  check('every cancellation is a CANCELLED invoice and nothing else is', cancelMismatch === 0, `${cancelledApi.size} cancelled on the API, ${cancelledExpected.size} confirmed by the sessions, ${cancelMismatch} mismatched`);

  const repaymentsByCustomer = new Map();
  for (const r of shop.repayments.filter((r) => r.outcome === 'done' || r.outcome === 'complete-after-retry' || r.outcome === 'absent-then-created')) repaymentsByCustomer.set(r.customerId, (repaymentsByCustomer.get(r.customerId) ?? 0) + 1);
  for (const r of ui?.repayments ?? []) repaymentsByCustomer.set(r.customerId, (repaymentsByCustomer.get(r.customerId) ?? 0) + 1);
  let repaymentMismatch = 0;
  let repaymentRows = 0;
  for (const customer of shop.customers.filter((c) => c.credit)) {
    const rows = [];
    for (let skip = 0; ; skip += 100) {
      const res = await call(shop.owner, 'GET', `/customers/${customer.id}/ledger?take=100&skip=${skip}`, undefined, { action: 'verify-ledger', retries: 10 });
      if (res.status !== 200) throw new Error(`ledger of ${customer.id} answered ${res.status}`);
      rows.push(...res.body.items);
      if (res.body.items.length < 100) break;
    }
    const payments = rows.filter((row) => row.type === 'PAYMENT').length;
    repaymentRows += payments;
    if (payments !== (repaymentsByCustomer.get(customer.id) ?? 0)) repaymentMismatch += 1;
  }
  check('every repayment key resolved to exactly one ledger row', repaymentMismatch === 0, `${repaymentRows} payment rows on the API for ${[...repaymentsByCustomer.values()].reduce((a, b) => a + b, 0)} confirmed; ${repaymentMismatch} customer(s) differ`);

  const dates = new Set([businessDate(new Date(runStart)), businessDate(new Date())]);
  for (const date of dates) {
    const res = await call(shop.owner, 'POST', '/reconciliation/run', { date }, { action: 'reconcile', retries: 10, timeoutMs: 120_000 });
    const clean = res.status === 201 && res.body.status === 'CLEAN' && Number(res.body.driftCount) === 0;
    result.reconciliation.push({ date, status: res.body?.status ?? `http ${res.status}`, driftCount: res.body?.driftCount ?? null, runId: res.body?.id ?? null, drifts: clean ? [] : (res.body?.checks ?? []).flatMap((c) => (c.drifts ?? []).slice(0, 5).map((d) => ({ check: c.name, ...d }))), summary: res.body?.summary ?? null });
    check(`reconciliation of ${date} is CLEAN`, clean, `${res.body?.status ?? res.status}, drift ${res.body?.driftCount ?? '?'}`);
  }
  result.pass = result.checks.every((c) => c.pass);
  return result;
}

// ---- main ------------------------------------------------------------------------------------------
async function main() {
  log(`business day: ${cfg.shops} shop(s) x ${cfg.cashiers} cashier(s), ${cfg.hours} h in ${cfg.minutes} min, targets ${targets.map((t) => t.url).join(' | ')}, UI sessions on ${cfg.uiShops} shop(s), chaos ${cfg.chaos ? 'on' : 'off'}`);
  for (const t of targets) await probe(t);
  if (healthy().length === 0) throw new Error('no target answers /api/health');

  log('setup: shops, staff, catalogue, customers, drawers');
  for (let i = 1; i <= cfg.shops; i++) {
    shops.push(await setupShop(i));
    log(`  shop ${i} ready (${shops[i - 1].shopId})`);
  }
  runStart = Date.now();
  runEnd = runStart + cfg.minutes * 60_000;
  const state = {
    webUrl: cfg.webUrl,
    apiUrl: targets[0].url,
    startedAt: new Date(runStart).toISOString(),
    endsAt: new Date(runEnd).toISOString(),
    minutes: cfg.minutes,
    uiReportFile,
    shops: shops.slice(0, cfg.uiShops).map((shop) => ({
      index: shop.index,
      shopId: shop.shopId,
      name: shop.name,
      owner: { email: shop.owner.email, password: shop.owner.password },
      cashier: shop.uiCashier ? { id: shop.uiCashier.id, email: shop.uiCashier.email, password: shop.uiCashier.password } : null,
      products: shop.products.filter((p) => !p.scarce).map((p) => ({ id: p.id, name: p.name, sku: p.sku, price: p.price })),
      customers: shop.customers.map((c) => ({ id: c.id, name: c.name, credit: c.credit })),
    })),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  log(`state for the browser sessions written to ${stateFile}; the day runs until ${state.endsAt}`);

  const loops = [];
  for (const shop of shops) {
    shop.cashiers.forEach((actor, i) => loops.push(cashierLoop(shop, actor, { midDayChange: i === 0 })));
    loops.push(managerLoop(shop));
    loops.push(ownerLoop(shop));
  }
  loops.push(chaosSchedule());
  const progress = setInterval(() => {
    log(`${Math.round(fraction() * 100)}% of the day: ${stats.sales.created + stats.sales.replayed} sales, ${stats.returns.created} returns, ${stats.cancellations.done} cancellations, ${stats.repayments.done} repayments, ${stats.receipts.done} receipts; requests ${counters.requests}, api 5xx ${counters.api5xx}, network errors ${counters.networkErrors}, targets up ${healthy().length}/${targets.length}`);
  }, 60_000);
  await Promise.all(loops);
  clearInterval(progress);
  log('closing time: every drawer closes');
  for (const shop of shops) for (const actor of [shop.manager, ...shop.cashiers]) await closeShift(shop, actor);

  // The browser sessions end on the same clock; give their report a moment.
  let ui = null;
  if (cfg.uiShops > 0) {
    const until = Date.now() + 4 * 60_000;
    while (!existsSync(uiReportFile) && Date.now() < until) await sleep(5000);
    if (existsSync(uiReportFile)) {
      ui = JSON.parse(readFileSync(uiReportFile, 'utf8'));
      log(`UI report read: ${ui.shops?.length ?? 0} shop(s)`);
    } else log(`UI report ${uiReportFile} did not appear within 4 min: the browser sessions count as absent`);
  }

  log('resolving the documents whose answer was lost, then verifying every shop');
  const shopResults = [];
  for (const shop of shops) {
    await resolveUnresolved(shop);
    shopResults.push(await verifyShop(shop, ui?.shops?.find((u) => u.index === shop.index)));
    const r = shopResults[shopResults.length - 1];
    log(`  shop ${shop.index}: ${r.pass ? 'PASS' : 'FAIL'} ${r.checks.filter((c) => !c.pass).map((c) => `[${c.name}: ${c.detail}]`).join(' ')}`);
  }
  probing = false;

  const inFlightOutcomes = inFlightAtKill.filter((p) => p.key).map((p) => {
    const record = shops.flatMap((s) => [...s.sales, ...s.returns, ...s.repayments]).find((r) => r.key === p.key);
    // A document answered on a later attempt tells what the dead instance did with the first one:
    // 200 on the retry means it had committed (complete), 201 means it had not (absent, then created).
    let outcome = record?.outcome ?? 'unknown';
    if (record && record.attempts > 1 && outcome === 'replayed') outcome = 'complete-after-retry';
    if (record && record.attempts > 1 && outcome === 'created') outcome = 'absent-then-created';
    return { key: p.key, action: p.action, actor: p.actor, target: p.target, outcome, status: record?.status ?? null, attempts: record?.attempts ?? null };
  });
  const uiErrors = (ui?.shops ?? []).reduce((n, s) => n + (s.api5xx ?? 0), 0);
  const uiFatal = (ui?.shops ?? []).filter((s) => s.fatal).length;
  const gate = [
    { name: 'zero 5xx answered by the API', pass: counters.api5xx === 0 && uiErrors === 0, detail: `${counters.api5xx} from the API sessions, ${uiErrors} seen by the browser sessions` },
    { name: 'every shop verified: no lost or duplicated invoice, returns, cancellations and repayments accounted for', pass: shopResults.every((r) => r.checks.filter((c) => !c.name.startsWith('reconciliation')).every((c) => c.pass)), detail: shopResults.filter((r) => !r.pass).map((r) => `shop ${r.shop}`).join(', ') || 'all shops' },
    { name: 'reconciliation CLEAN for every shop and business date', pass: shopResults.every((r) => r.reconciliation.every((x) => x.status === 'CLEAN' && x.driftCount === 0)), detail: shopResults.flatMap((r) => r.reconciliation.map((x) => `shop ${r.shop} ${x.date}: ${x.status}`)).join('; ') },
    { name: "the killed instance's in-flight documents are complete or absent, never partial", pass: inFlightOutcomes.every((o) => ['created', 'replayed', 'complete-after-retry', 'absent-then-created', 'refused', 'refused-on-retry', 'done'].includes(o.outcome)), detail: `${inFlightOutcomes.length} keyed request(s) in flight at the kill: ${Object.entries(inFlightOutcomes.reduce((m, o) => ({ ...m, [o.outcome]: (m[o.outcome] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}` },
  ];
  if (cfg.chaos) {
    gate.push({ name: 'both failures were injected (Redis restarted, one API instance killed and started again)', pass: chaosEvents.filter((e) => e.ok === true).length >= 3 && chaosEvents.some((e) => e.name === 'api-back' && e.ok), detail: chaosEvents.map((e) => `${e.name}: ${e.ok === null ? 'skipped' : e.ok ? 'ok' : 'FAILED'}`).join(', ') });
  }
  if (cfg.uiShops > 0) gate.push({ name: 'the browser sessions ran the whole day', pass: ui !== null && uiFatal === 0 && (ui.shops?.length ?? 0) === cfg.uiShops, detail: ui ? `${ui.shops.length} shop(s), ${ui.shops.reduce((n, s) => n + (s.sales?.length ?? 0), 0)} UI sales, ${uiFatal} fatal session error(s)` : 'no UI report' });
  const pass = gate.every((g) => g.pass);

  const report = {
    result: pass ? 'PASS' : 'FAIL',
    plan: planFile,
    config: { ...cfg, hooks: Object.fromEntries(Object.entries(cfg.hooks).map(([k, v]) => [k, v ? 'configured' : ''])), targets: targets.map((t) => t.url) },
    startedAt: startedAt.toISOString(),
    dayStartedAt: new Date(runStart).toISOString(),
    dayEndedAt: new Date(runEnd).toISOString(),
    finishedAt: new Date().toISOString(),
    stats,
    counters,
    api5xxSamples,
    chaos: { events: chaosEvents, killWindow: killWindow ? { from: new Date(killWindow.from).toISOString(), to: killWindow.to ? new Date(killWindow.to).toISOString() : null, target: targets[killWindow.target]?.url } : null, inFlightAtKill: inFlightOutcomes },
    targets: targets.map((t) => ({ url: t.url, transitions: t.transitions })),
    gate,
    shops: shopResults.map((r, i) => ({ ...r, sales: shops[i].sales.length, returns: shops[i].returns.length, cancellations: shops[i].cancellations.length, repayments: shops[i].repayments.length, receipts: shops[i].receipts, shiftEvents: shops[i].shiftEvents, polls: shops[i].polls, errors: shops[i].errors })),
    ui: ui ? { shops: ui.shops.map((s) => ({ index: s.index, sales: s.sales?.length ?? 0, returns: s.returns?.length ?? 0, cancellations: s.cancellations?.length ?? 0, repayments: s.repayments?.length ?? 0, shift: s.shift, api5xx: s.api5xx ?? 0, errors: s.errors ?? [], fatal: s.fatal ?? null })) } : null,
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  writeFileSync(summaryFile, summarize(report));
  console.log(`\n${summarize(report)}`);
  console.log(`== ${report.result} (report ${reportFile}, attempts ${attemptsFile})`);
  process.exit(pass ? 0 : 1);
}

function summarize(report) {
  const s = report.stats;
  const lines = [
    `# Business day ${report.result} (${report.dayStartedAt} to ${report.dayEndedAt})`,
    '',
    `${report.config.shops} shop(s) x ${report.config.cashiers} cashier(s), ${report.config.hours} h compressed into ${report.config.minutes} min, targets ${report.config.targets.join(' | ')}, UI sessions on ${report.config.uiShops} shop(s).`,
    '',
    '| Figure | Value |',
    '|---|---:|',
    `| Sales created / replayed / refused / unresolved | ${s.sales.created} / ${s.sales.replayed} / ${s.sales.refused} / ${s.sales.unresolved} |`,
    `| Sales by tender (cash / UPI / credit), with a discount | ${s.sales.byTender.CASH} / ${s.sales.byTender.UPI} / ${s.sales.byTender.CREDIT}, ${s.sales.discounted} |`,
    `| Refusals by code | ${Object.entries(s.sales.refusedBy).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
    `| Manager sales (above-authority discount) | ${s.managerSales} |`,
    `| Returns created / replayed / refused | ${s.returns.created} / ${s.returns.replayed} / ${s.returns.refused} |`,
    `| Cancellations done / refused | ${s.cancellations.done} / ${s.cancellations.refused} |`,
    `| Repayments done / refused (skipped: no balance yet) | ${s.repayments.done} / ${s.repayments.refused} (${s.repayments.skippedNoBalance}) |`,
    `| Stock receipts (order -> approval -> GRN -> accept) done / abandoned | ${s.receipts.done} / ${s.receipts.abandoned} |`,
    `| Mid-day shift changes | ${s.shiftChanges} |`,
    `| Dashboard polls (4 reads each) | ${s.polls} |`,
    `| Requests / API 5xx / edge 5xx / network errors / 429 | ${report.counters.requests} / ${report.counters.api5xx} / ${report.counters.edge5xx} / ${report.counters.networkErrors} / ${report.counters.rateLimited} |`,
    '',
    '## Failures injected',
    '',
    ...(report.chaos.events.length ? report.chaos.events.map((e) => `- ${e.at} ${e.name}: ${e.ok === null ? 'skipped (no hook)' : e.ok ? 'ok' : 'FAILED'}${e.output ? ` (${e.output.replace(/\s+/g, ' ').slice(0, 160)})` : ''}`) : ['- none (chaos off)']),
    report.chaos.killWindow ? `- instance ${report.chaos.killWindow.target} down from ${report.chaos.killWindow.from} to ${report.chaos.killWindow.to ?? 'never back'}; ${report.chaos.inFlightAtKill.length} keyed request(s) in flight: ${report.chaos.inFlightAtKill.map((o) => `${o.action} ${o.outcome}`).join(', ') || 'none'}` : '',
    '',
    '## Gate',
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...report.gate.map((g) => `| ${g.name} | ${g.pass ? 'PASS' : 'FAIL'} | ${g.detail} |`),
    '',
    '## Shops',
    '',
    '| Shop | Sales | Returns | Cancellations | Repayments | Receipts | Reconciliation | Result |',
    '|---|---:|---:|---:|---:|---:|---|---|',
    ...report.shops.map((r) => `| ${r.shop} | ${r.sales} | ${r.returns} | ${r.cancellations} | ${r.repayments} | ${r.receipts.filter((x) => x.outcome === 'done').length}/${r.receipts.length} | ${r.reconciliation.map((x) => `${x.date} ${x.status}${x.driftCount ? ` (${x.driftCount})` : ''}`).join(', ')} | ${r.pass ? 'PASS' : 'FAIL: ' + r.checks.filter((c) => !c.pass).map((c) => c.name).join('; ')} |`),
    '',
    report.ui ? `UI sessions: ${report.ui.shops.map((u) => `shop ${u.index} ${u.sales} sales, ${u.returns} returns, ${u.cancellations} cancellations, ${u.repayments} repayments, shift ${u.shift ?? '?'}, errors ${u.errors.length}${u.fatal ? `, FATAL ${u.fatal}` : ''}`).join('; ')}` : 'UI sessions: none',
    '',
  ];
  return lines.join('\n');
}

main().catch((error) => {
  console.error(`business day failed before the gate: ${error?.stack || error}`);
  process.exit(2);
});

// Roadmap 9.16: the production rate limits under a real shop's traffic.
//
// Drives the legitimate request mix of LIMITS_SHOPS shops, each with
// LIMITS_TERMINALS browser terminals behind ONE client address (a shop's
// terminals share the shop's NAT address, and the web server forwards the
// browser's address to the API, so this is what the limiter sees), against an
// API that runs the PRODUCTION limits, and asserts that none of that traffic
// is answered 429. Then it proves the brute-force limits still hold: a flood
// of wrong passwords from one address is 429 by attempt
// AUTH_RATE_LIMIT_SHORT_LIMIT + 1, a different address still signs in, and
// attempts spread over many addresses against one account are 429 by
// AUTH_RATE_LIMIT_ACCOUNT_LIMIT + 1.
//
// The traffic model (docs/PRODUCTION_LIMITS.md) per terminal, taken from the
// web application's own polling and the POS flow:
//   - page load: 4 dashboard reads, notifications, the current shift, the
//     product grid (7 requests, once)
//   - dashboard poll: 4 reads every 30 s; notifications every 60 s
//   - a sale every 20 s: product search, customer search, checkout, the
//     grid refresh and the shift banner (5 requests)
// The gate runs every terminal of a shop from the first second (the worst
// burst: every terminal loading and billing at once), measures the requests
// per 10 s, per minute and the hourly rate they extrapolate to, and reports
// the headroom against the limits the API advertises in its
// `X-RateLimit-Limit-*` headers.
//
// Environment:
//   LOAD_TARGET            API origin (required), e.g. http://127.0.0.1:3002
//   LIMITS_SHOPS           shops, one address each (default 3)
//   LIMITS_TERMINALS       terminals per shop (default 3)
//   LIMITS_DURATION_S      seconds of legitimate traffic (default 45: one
//                          dashboard poll and two sales per terminal)
//   LIMITS_FORWARD_FOR     1 (default): each shop sends X-Forwarded-For
//                          10.<shop>.0.1, which the API honours under
//                          TRUST_PROXY >= 1. 0: through an edge that discards
//                          the header (roadmap 9.8): every request shares the
//                          caller's address, so run LIMITS_SHOPS=1 and the
//                          distributed check is skipped.
//   LIMITS_EXPECT          0 to skip the check that the advertised limits
//                          equal the production values below
//   LIMITS_EXPECT_SHORT / _MEDIUM / _LONG / _AUTH_SHORT / _AUTH_MEDIUM /
//   _AUTH_LONG / _AUTH_ACCOUNT  the production values (defaults are the
//                          SecurityConfig defaults = apps/api/.env.production)
//   LIMITS_MIN_HEADROOM    the limit must be at least this multiple of the
//                          measured legitimate rate (default 1.25)
//   LIMITS_REPORT          JSON report path (default load/reports/limits-<stamp>.json)
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.env.LOAD_TARGET;
if (!target) throw new Error('LOAD_TARGET is required (e.g. http://127.0.0.1:3002)');
const base = `${target.replace(/\/$/, '')}/api`;
const shopsWanted = Number(process.env.LIMITS_SHOPS ?? 3);
const terminalsPerShop = Number(process.env.LIMITS_TERMINALS ?? 3);
const durationS = Number(process.env.LIMITS_DURATION_S ?? 45);
const forwardFor = (process.env.LIMITS_FORWARD_FOR ?? '1') !== '0';
const minHeadroom = Number(process.env.LIMITS_MIN_HEADROOM ?? 1.25);
const expectLimits = (process.env.LIMITS_EXPECT ?? '1') !== '0';
const expected = {
  short: Number(process.env.LIMITS_EXPECT_SHORT ?? 60),
  medium: Number(process.env.LIMITS_EXPECT_MEDIUM ?? 200),
  long: Number(process.env.LIMITS_EXPECT_LONG ?? 10000),
  'auth-short': Number(process.env.LIMITS_EXPECT_AUTH_SHORT ?? 5),
  'auth-medium': Number(process.env.LIMITS_EXPECT_AUTH_MEDIUM ?? 20),
  'auth-long': Number(process.env.LIMITS_EXPECT_AUTH_LONG ?? 100),
  'auth-account': Number(process.env.LIMITS_EXPECT_AUTH_ACCOUNT ?? 10),
};
const DASHBOARD_POLL_MS = 30_000;
const NOTIFICATION_POLL_MS = 60_000;
const SALE_EVERY_MS = 20_000;
const SHORT_WINDOW_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => randomUUID().slice(0, 8);
const addressOf = (shop) => (forwardFor ? `10.${shop}.0.1` : undefined);
const brute = { flood: forwardFor ? '10.200.0.1' : undefined, bystander: forwardFor ? '10.200.0.2' : undefined, spread: (n) => (forwardFor ? `10.201.${Math.floor(n / 250)}.${(n % 250) + 1}` : undefined) };

/** Every advertised limit seen so far, by throttler name. */
const advertised = {};
/** Every request of the legitimate phase: { shop, terminal, at, path, status }. */
const legit = [];

async function http(method, path, { body, token, address, record } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (address) headers['x-forwarded-for'] = address;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const [name, value] of res.headers) {
    const m = /^x-ratelimit-limit-(.+)$/.exec(name);
    if (m) advertised[m[1]] = Number(value);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (record) legit.push({ ...record, at: Date.now(), path: path.replace(/\?.*$/, ''), status: res.status });
  return { status: res.status, body: json, retryAfter: res.headers.get('retry-after') };
}

function must(res, status, what) {
  if (res.status !== status) throw new Error(`${what} -> ${res.status} (expected ${status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  return res.body;
}

// ---- phase 1: legitimate traffic -------------------------------------------
async function prepareShop(n) {
  const address = addressOf(n);
  const s = stamp();
  const email = `limits-${s}@load.local`;
  const password = `Limits-${s}-Passw0rd!`;
  const record = { shop: n, terminal: 0 };
  must(await http('POST', '/auth/register', { body: { email, password, name: 'Limits Owner', shopName: `Limits shop ${s}` }, address, record }), 201, 'register');
  const login = must(await http('POST', '/auth/login', { body: { email, password }, address, record }), 201, 'login');
  const token = login.access_token;
  const product = must(await http('POST', '/products', { body: { name: `Limits product ${s}`, sku: `LIM-${s}`, costPrice: 10, sellingPrice: 20, mrp: 25, wholesalePrice: 15, unit: 'PCS', gstRate: 'ZERO' }, token, address, record }), 201, 'product');
  const item = must(await http('POST', '/inventory-domain', { body: { productId: product.id }, token, address, record }), 201, 'inventory item');
  must(await http('POST', `/inventory-domain/${item.id}/adjust`, { body: { reason: 'OPENING_BALANCE', quantityChange: 100000, notes: 'limits gate opening stock' }, token, address, record }), 201, 'opening stock');
  must(await http('POST', '/shifts/open', { body: { openingCash: 0 }, token, address, record }), 201, 'shift');
  return { n, address, email, password, token, productId: product.id, sku: `LIM-${s}` };
}

async function terminal(shop, t, until) {
  const { token, address } = shop;
  const record = { shop: shop.n, terminal: t };
  const get = (path) => http('GET', path, { token, address, record });
  const post = (path, body) => http('POST', path, { body, token, address, record });
  const dashboard = () => Promise.all([get('/dashboard/summary'), get('/dashboard/kpis'), get('/dashboard/trends?days=30'), get('/dashboard/insights')]);
  const sale = async () => {
    await get(`/search?q=${encodeURIComponent(shop.sku)}&limit=30`);
    await post('/customers/search', { query: 'walk', take: 8 });
    await post('/billing/invoice', { idempotencyKey: randomUUID(), items: [{ productId: shop.productId, quantity: 1 }], payments: [{ tender: 'CASH', amount: 20 }] });
    await get('/products?limit=50&offset=0');
    await get('/shifts/current');
  };
  // Page load: the dashboard, the navbar's notifications, the POS shell.
  await Promise.all([dashboard(), get('/notifications'), get('/shifts/current'), get('/products?limit=50&offset=0')]);
  const start = Date.now();
  let nextDashboard = start + DASHBOARD_POLL_MS;
  let nextNotifications = start + NOTIFICATION_POLL_MS;
  let nextSale = start; // the first sale right after the page load
  while (Date.now() < until) {
    const now = Date.now();
    if (now >= nextSale) {
      await sale();
      nextSale += SALE_EVERY_MS;
    }
    if (now >= nextDashboard) {
      await dashboard();
      nextDashboard += DASHBOARD_POLL_MS;
    }
    if (now >= nextNotifications) {
      await get('/notifications');
      nextNotifications += NOTIFICATION_POLL_MS;
    }
    await sleep(250);
  }
}

function analyseShop(n, rows) {
  const general = rows.filter((r) => !r.path.startsWith('/auth/'));
  const auth = rows.filter((r) => r.path.startsWith('/auth/'));
  const first = Math.min(...rows.map((r) => r.at));
  const last = Math.max(...rows.map((r) => r.at));
  const spanS = Math.max(1, (last - first) / 1000);
  const perWindow = (list, ms) => {
    let max = 0;
    const times = list.map((r) => r.at).sort((a, b) => a - b);
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[j] < times[i] - ms + 1) j++;
      max = Math.max(max, i - j + 1);
    }
    return max;
  };
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return {
    shop: n,
    requests: rows.length,
    general: general.length,
    auth: auth.length,
    spanSeconds: Number(spanS.toFixed(1)),
    statuses,
    tooMany: rows.filter((r) => r.status === 429).length,
    failures: rows.filter((r) => r.status >= 500).length,
    /** The busiest 10 s and 60 s of general traffic (sliding), and the hourly rate the run extrapolates to. */
    generalPer10s: perWindow(general, SHORT_WINDOW_MS),
    generalPer60s: perWindow(general, 60_000),
    generalPerHourExtrapolated: Math.round((general.length / spanS) * 3600),
    authPer10s: perWindow(auth, SHORT_WINDOW_MS),
    authPer60s: perWindow(auth, 60_000),
  };
}

// ---- phase 2: brute force ---------------------------------------------------
async function bruteForce() {
  const s = stamp();
  const victim = { email: `victim-${s}@load.local`, password: `Victim-${s}-Passw0rd!` };
  const bystander = { email: `bystander-${s}@load.local`, password: `Bystander-${s}-Passw0rd!` };
  // Both accounts are registered from the bystander address, two auth hits there.
  must(await http('POST', '/auth/register', { body: { ...victim, name: 'Victim', shopName: `Victim shop ${s}` }, address: brute.bystander }), 201, 'victim register');
  must(await http('POST', '/auth/register', { body: { ...bystander, name: 'Bystander', shopName: `Bystander shop ${s}` }, address: brute.bystander }), 201, 'bystander register');

  const limit = expected['auth-short'];
  const attempts = [];
  for (let i = 1; i <= limit + 3; i++) {
    const res = await http('POST', '/auth/login', { body: { email: victim.email, password: `wrong-${i}` }, address: brute.flood });
    attempts.push({ attempt: i, status: res.status, retryAfter: res.retryAfter });
  }
  const firstTooMany = attempts.find((a) => a.status === 429)?.attempt ?? null;
  const allowedBefore = attempts.filter((a) => a.attempt < (firstTooMany ?? Infinity)).every((a) => a.status === 401);
  const bystanderLogin = await http('POST', '/auth/login', { body: bystander, address: brute.bystander });
  const victimFromFlood = await http('POST', '/auth/login', { body: victim, address: brute.flood });
  const flood = {
    check: 'one address floods one account with wrong passwords',
    attempts,
    firstTooManyAt: firstTooMany,
    expectedTooManyAt: limit + 1,
    bystanderStatus: bystanderLogin.status,
    victimOwnPasswordFromFloodAddress: victimFromFlood.status,
    pass: firstTooMany === limit + 1 && allowedBefore && bystanderLogin.status === 201 && victimFromFlood.status === 429,
  };

  let spread;
  if (!forwardFor) {
    spread = { check: 'attempts spread over many addresses against one account', skipped: 'LIMITS_FORWARD_FOR=0: every attempt would share the caller address and hit the per-address limit first' };
  } else {
    // A fresh victim so the lockout and the flood above do not take part; one wrong attempt per address.
    const s2 = stamp();
    const victim2 = { email: `spread-${s2}@load.local`, password: `Spread-${s2}-Passw0rd!` };
    must(await http('POST', '/auth/register', { body: { ...victim2, name: 'Spread', shopName: `Spread shop ${s2}` }, address: brute.spread(0) }), 201, 'spread victim register');
    const accountLimit = expected['auth-account'];
    const rows = [];
    for (let i = 1; i <= accountLimit + 3; i++) {
      const res = await http('POST', '/auth/login', { body: { email: victim2.email, password: `wrong-${i}` }, address: brute.spread(i) });
      rows.push({ attempt: i, address: brute.spread(i), status: res.status });
    }
    const first429 = rows.find((r) => r.status === 429)?.attempt ?? null;
    // The same addresses may still sign in to ANOTHER account: the cap is per account, not per address.
    const other = await http('POST', '/auth/login', { body: bystander, address: brute.spread(1) });
    spread = {
      check: 'attempts spread over many addresses against one account',
      attempts: rows,
      firstTooManyAt: first429,
      expectedTooManyAt: accountLimit + 1,
      otherAccountFromUsedAddress: other.status,
      pass: first429 === accountLimit + 1 && rows.filter((r) => r.attempt < first429).every((r) => r.status === 401) && other.status === 201,
    };
  }
  return { flood, spread };
}

// ---- run ----------------------------------------------------------------------
const startedAt = new Date().toISOString();
console.log(`== limits gate against ${base}: ${shopsWanted} shop(s) x ${terminalsPerShop} terminal(s), ${durationS} s, ${forwardFor ? 'one forwarded address per shop' : 'the caller address for everything'}`);
const health = await fetch(`${base}/health`);
if (!health.ok) throw new Error(`no API answers at ${base}/health (${health.status})`);

console.log('== phase 1: prepare the shops (owner, product, stock, shift), one address each');
const shops = [];
for (let n = 1; n <= shopsWanted; n++) shops.push(await prepareShop(n));
// The set-up requests belong to the same address buckets; let the short window pass so the
// burst measured below is the terminals' own.
await sleep(SHORT_WINDOW_MS + 500);

console.log(`== phase 1: ${terminalsPerShop} terminal(s) per shop for ${durationS} s (page load, dashboard poll, notifications, a sale every ${SALE_EVERY_MS / 1000} s)`);
// Each terminal signs in (as the web does) and then runs its page load, polls and sales; every terminal
// of a shop starts in the same second, the worst burst a shop can produce.
const until = Date.now() + durationS * 1000;
await Promise.all(
  shops.flatMap((shop) =>
    Array.from({ length: terminalsPerShop }, async (_, i) => {
      const record = { shop: shop.n, terminal: i + 1 };
      const login = must(await http('POST', '/auth/login', { body: { email: shop.email, password: shop.password }, address: shop.address, record }), 201, `terminal ${i + 1} login`);
      await terminal({ ...shop, token: login.access_token }, i + 1, until);
    }),
  ),
);
const perShop = shops.map((shop) => analyseShop(shop.n, legit.filter((r) => r.shop === shop.n)));
const totalTooMany = perShop.reduce((n, s) => n + s.tooMany, 0);
const totalFailures = perShop.reduce((n, s) => n + s.failures, 0);
const busiest = {
  generalPer10s: Math.max(...perShop.map((s) => s.generalPer10s)),
  generalPer60s: Math.max(...perShop.map((s) => s.generalPer60s)),
  generalPerHourExtrapolated: Math.max(...perShop.map((s) => s.generalPerHourExtrapolated)),
  authPer10s: Math.max(...perShop.map((s) => s.authPer10s)),
  authPer60s: Math.max(...perShop.map((s) => s.authPer60s)),
};
const headroom = {
  short: advertised.short ? Number((advertised.short / busiest.generalPer10s).toFixed(2)) : null,
  medium: advertised.medium ? Number((advertised.medium / busiest.generalPer60s).toFixed(2)) : null,
  long: advertised.long ? Number((advertised.long / busiest.generalPerHourExtrapolated).toFixed(2)) : null,
  'auth-short': advertised['auth-short'] ? Number((advertised['auth-short'] / busiest.authPer10s).toFixed(2)) : null,
  'auth-medium': advertised['auth-medium'] ? Number((advertised['auth-medium'] / busiest.authPer60s).toFixed(2)) : null,
};
for (const s of perShop) {
  console.log(`   shop ${s.shop}: ${s.requests} requests over ${s.spanSeconds} s, statuses ${JSON.stringify(s.statuses)}; busiest 10 s ${s.generalPer10s}, busiest 60 s ${s.generalPer60s}, hourly rate ${s.generalPerHourExtrapolated}; auth ${s.authPer10s}/10 s`);
}

console.log('== phase 2: brute force (fresh addresses)');
const bf = await bruteForce();
console.log(`   flood: first 429 at attempt ${bf.flood.firstTooManyAt} (expected ${bf.flood.expectedTooManyAt}); bystander ${bf.flood.bystanderStatus}; victim's own password from the flooding address ${bf.flood.victimOwnPasswordFromFloodAddress}`);
console.log(`   spread: ${bf.spread.skipped ? `SKIPPED (${bf.spread.skipped})` : `first 429 at attempt ${bf.spread.firstTooManyAt} (expected ${bf.spread.expectedTooManyAt}); another account from a used address ${bf.spread.otherAccountFromUsedAddress}`}`);

// ---- verdict ------------------------------------------------------------------
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
console.log('== verdict');
check('the API advertises its limits', ['short', 'medium', 'long', 'auth-short', 'auth-medium', 'auth-long'].every((k) => Number.isFinite(advertised[k])), JSON.stringify(advertised));
if (expectLimits) {
  const diff = Object.entries(expected).filter(([k, v]) => advertised[k] !== undefined && advertised[k] !== v);
  check('the advertised limits are the production values', diff.length === 0, diff.length ? diff.map(([k, v]) => `${k}: advertised ${advertised[k]}, expected ${v}`).join('; ') : 'all equal');
}
check('no legitimate request was answered 429', totalTooMany === 0, `${legit.length} requests, ${totalTooMany} x 429`);
check('no legitimate request failed with 5xx', totalFailures === 0, `${totalFailures} x 5xx`);
check(`the headroom over the busiest shop is at least ${minHeadroom}x on every general window`, ['short', 'medium', 'long'].every((k) => headroom[k] !== null && headroom[k] >= minHeadroom), JSON.stringify(headroom));
check('a flood of wrong passwords from one address is refused with 429 at the configured attempt, a different address still signs in', bf.flood.pass, `first 429 at ${bf.flood.firstTooManyAt}, bystander ${bf.flood.bystanderStatus}`);
if (!bf.spread.skipped) check('attempts spread over many addresses against one account are refused at the configured attempt', bf.spread.pass, `first 429 at ${bf.spread.firstTooManyAt}`);

const pass = checks.every((c) => c.pass);
const report = {
  target: base,
  startedAt,
  finishedAt: new Date().toISOString(),
  config: { shops: shopsWanted, terminals: terminalsPerShop, durationS, forwardFor, minHeadroom, expected: expectLimits ? expected : null },
  advertised,
  legitimate: { requests: legit.length, tooMany: totalTooMany, failures: totalFailures, perShop, busiest, headroom },
  bruteForce: bf,
  checks,
  result: pass ? 'PASS' : 'FAIL',
};
const reportFile = process.env.LIMITS_REPORT || join(dirname(fileURLToPath(import.meta.url)), 'reports', `limits-${startedAt.replace(/[:.]/g, '').replace('T', 'T')}.json`);
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(`== ${report.result} (report ${reportFile})`);
process.exit(pass ? 0 : 1);

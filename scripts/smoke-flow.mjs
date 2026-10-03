#!/usr/bin/env node
// The business half of the phase 7 exit gate (roadmap 7.3), against a running
// deployment: probes, registration (creates the shop OWNER), API login, the
// web's own credentials sign-in (NextAuth -> API over the server-side route),
// a stocked product, an open shift, a cash sale and the dashboard figure.
// Public routes only; no database access. Used by scripts/compose-smoke.sh
// and runnable against any pair of servers:
//
//   SMOKE_API_URL=http://127.0.0.1:3002/api SMOKE_WEB_URL=http://127.0.0.1:3000 node scripts/smoke-flow.mjs
import { randomBytes, randomUUID } from 'node:crypto';

const API = (process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3002/api').replace(/\/$/, '');
const WEB = (process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const step = (msg) => console.log(`\n==> ${msg}`);
const fail = (msg) => {
  console.error(`\nSMOKE FAILED: ${msg}`);
  process.exit(1);
};

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function expectStatus(label, want, res) {
  if (res.status !== want) fail(`${label}: expected HTTP ${want}, got ${res.status}: ${JSON.stringify(res.json).slice(0, 600)}`);
  return res.json;
}

/** Minimal cookie jar for the NextAuth sign-in round trip. */
class Jar {
  cookies = new Map();
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

step(`probes: API readiness (${API}) and web liveness (${WEB})`);
{
  const ready = await call('GET', '/health/ready');
  const body = expectStatus('API readiness', 200, ready);
  if (body?.checks?.database !== 'up' || body?.checks?.redis !== 'up') fail(`readiness checks: ${JSON.stringify(body)}`);
  const live = await fetch(`${WEB}/api/health`);
  if (!live.ok || (await live.json())?.status !== 'ok') fail(`web liveness answered ${live.status}`);
  const login = await fetch(`${WEB}/login`);
  if (login.status !== 200) fail(`web login page answered ${login.status}`);
}

const suffix = randomBytes(4).toString('hex');
const email = `smoke-${suffix}@smoke.local`;
const password = `Smoke-${suffix}-Passw0rd!`;

step('register the shop owner, log in through the API');
{
  const reg = expectStatus('register', 201, await call('POST', '/auth/register', { email, password, name: 'Smoke Owner', shopName: `Smoke shop ${suffix}` }));
  if (reg?.role !== 'OWNER') fail(`registration did not create an OWNER (${JSON.stringify(reg).slice(0, 300)})`);
}
const login = expectStatus('login', 201, await call('POST', '/auth/login', { email, password }));
const token = login?.access_token;
if (!token) fail('login answered without an access token');

step("sign in through the web's own credentials flow (NextAuth -> API)");
{
  const jar = new Jar();
  const csrfRes = await fetch(`${WEB}/api/auth/csrf`);
  jar.absorb(csrfRes);
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, json: 'true' });
  const cb = await fetch(`${WEB}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: form,
    redirect: 'manual',
  });
  jar.absorb(cb);
  if (![200, 302].includes(cb.status)) fail(`web credentials sign-in answered ${cb.status}`);
  const session = await (await fetch(`${WEB}/api/auth/session`, { headers: { cookie: jar.header() } })).json();
  if (session?.user?.email !== email) fail(`web session does not carry the signed-in user: ${JSON.stringify(session).slice(0, 300)}`);
}

step('a product with stock, an open shift, a cash sale, the dashboard figure');
const product = expectStatus('create product', 201, await call('POST', '/products', {
  name: 'Smoke tea', sku: `SMOKE-${suffix}`, costPrice: 10, sellingPrice: 20, mrp: 25, wholesalePrice: 15, unit: 'PCS', gstRate: 'ZERO',
}, token));
const item = expectStatus('inventory item', 201, await call('POST', '/inventory-domain', { productId: product.id }, token));
expectStatus('opening stock', 201, await call('POST', `/inventory-domain/${item.id}/adjust`, { reason: 'OPENING_BALANCE', quantityChange: 10, notes: 'smoke opening stock' }, token));
expectStatus('open shift', 201, await call('POST', '/shifts/open', { openingCash: 0 }, token));
const sale = expectStatus('sale', 201, await call('POST', '/billing/invoice', {
  idempotencyKey: randomUUID(),
  items: [{ productId: product.id, quantity: 2 }],
  payments: [{ tender: 'CASH', amount: 40 }],
}, token));
if (sale?.invoice?.status !== 'COMPLETED') fail(`sale not COMPLETED: ${JSON.stringify(sale).slice(0, 400)}`);
if (sale?.stock?.[0]?.productStockAfter !== 8) fail(`stock after the sale is not 8: ${JSON.stringify(sale.stock)}`);
const summary = expectStatus('dashboard', 200, await call('GET', '/dashboard/summary', undefined, token));
if (Number(summary?.todaySales) !== 40) fail(`dashboard todaySales is not 40: ${JSON.stringify(summary).slice(0, 300)}`);

console.log(`\nSMOKE FLOW PASSED: owner ${email} registered, signed in on the API and the web, sale ${sale.invoice.invoiceNumber} completed, dashboard agrees.`);

#!/usr/bin/env node
// Roadmap 9.20 gate: "an import of 5,000 products and 2,000 customers
// completes, is idempotent on re-run, and the reconciliation is clean
// afterwards", run over HTTP against a deployed API exactly as a shop's
// first day goes (docs/ONBOARDING.md):
//
//   1. a fresh shop (public registration) and its profile with the state
//   2. products: dry run, apply, re-run (every row unchanged)
//   3. opening stock for every stocked product: dry run, apply, re-run
//   4. customers with opening udhar and advances: dry run, apply, re-run
//   5. POST /reconciliation/run is CLEAN, and the dashboard's product and
//      customer counts, inventory value (Σ quantity × cost) and outstanding
//      udhar (Σ opening balances) equal what the generated files say.
//
// The files are generated deterministically (ONBOARDING_SEED): realistic
// GST slabs, units (KG and LTR sold in decimals), barcodes (EAN-13 with
// their check digit, some rows naming the product by barcode), phone
// spellings (+91, a trunk 0), state spellings ("orissa", "New Delhi"),
// advances as negative balances, products with nothing on the shelf.
//
//   ONBOARDING_TARGET    API origin (required), e.g. http://127.0.0.1:3002
//   ONBOARDING_PRODUCTS  5000;  ONBOARDING_CUSTOMERS  2000
//   ONBOARDING_SEED      20261008
//   ONBOARDING_FILES     keep the generated CSVs here (default a temp dir)
//   ONBOARDING_REPORT    JSON report (default onboarding-gate-<stamp>.json in the cwd)
//   ONBOARDING_EMAIL / ONBOARDING_PASSWORD  an existing, empty shop's owner
//                        instead of registering one
//   ONBOARDING_TIMEOUT_S per import job (default 1800)
// Exit 0 when every check passes, 1 otherwise.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importClient, login, summarize } from './import.mjs';

const target = (process.env.ONBOARDING_TARGET ?? '').replace(/\/$/, '');
if (!target) throw new Error('ONBOARDING_TARGET is required (the API origin)');
const PRODUCTS = Number(process.env.ONBOARDING_PRODUCTS ?? 5000);
const CUSTOMERS = Number(process.env.ONBOARDING_CUSTOMERS ?? 2000);
const SEED = Number(process.env.ONBOARDING_SEED ?? 20261008);
const TIMEOUT_MS = Number(process.env.ONBOARDING_TIMEOUT_S ?? 1800) * 1000;
const filesDir = process.env.ONBOARDING_FILES ?? mkdtempSync(join(tmpdir(), 'onboarding-gate-'));
mkdirSync(filesDir, { recursive: true });
const reportPath = process.env.ONBOARDING_REPORT ?? `onboarding-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

// ---------------------------------------------------------------------------
// Deterministic data
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (items) => items[Math.floor(rng() * items.length)];
const between = (lo, hi) => lo + rng() * (hi - lo);
const pad = (n, width) => String(n).padStart(width, '0');
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (header, rows) => `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\n')}\n`;

/** EAN-13 with its check digit. */
function ean13(body12) {
  const sum = [...body12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body12}${(10 - (sum % 10)) % 10}`;
}

const CATEGORIES = ['Rice & Grains', 'Pulses', 'Flour & Atta', 'Edible Oil', 'Spices', 'Salt & Sugar', 'Tea & Coffee', 'Biscuits', 'Snacks', 'Noodles & Pasta',
  'Breakfast Cereals', 'Dry Fruits', 'Sauces & Pickles', 'Dairy', 'Beverages', 'Juices', 'Chocolates', 'Bakery', 'Frozen Foods', 'Baby Care',
  'Personal Care', 'Hair Care', 'Skin Care', 'Oral Care', 'Bath & Soap', 'Detergents', 'Cleaners', 'Kitchen Tools', 'Stationery', 'Batteries',
  'Pooja Items', 'Pet Food', 'Health Drinks', 'Masala Mixes', 'Ready to Eat', 'Sweets', 'Namkeen', 'Plastics', 'Disposables', 'Home Care'];
const STATES = ['Karnataka', 'Karnataka', 'Karnataka', 'karnataka', 'Tamil Nadu', 'Kerala', 'Maharashtra', 'Andhra Pradesh', 'Telangana', 'Orissa', 'New Delhi', 'Goa'];

const products = [];
for (let i = 1; i <= PRODUCTS; i++) {
  const unit = rng() < 0.8 ? 'PCS' : pick(['KG', 'KG', 'LTR', 'PACK']);
  const type = i % 250 === 0 ? 'SERVICE' : 'SIMPLE';
  const cost = Math.round(between(5, 2000) * 100) / 100;
  const selling = Math.round(cost * between(1.05, 1.4) * 100) / 100;
  const mrp = Math.ceil(selling * between(1, 1.15) * 100) / 100;
  products.push({
    sku: `GATE-${pad(i, 5)}`,
    name: `${type === 'SERVICE' ? 'Delivery charge' : 'Item'} ${i}`,
    category: CATEGORIES[i % CATEGORIES.length],
    barcode: i % 10 === 0 || type === 'SERVICE' ? '' : ean13(`890${pad(SEED % 1000, 3)}${pad(i, 6)}`),
    hsnCode: String(Math.floor(between(10000000, 99999999))),
    unit,
    gstRate: pick(['0', '5', '5', '12', '18', '18', '18', '28']),
    cessRate: i % 100 === 0 ? '12' : '0',
    costPrice: cost.toFixed(2),
    sellingPrice: selling.toFixed(2),
    mrp: mrp.toFixed(2),
    wholesalePrice: ((cost + selling) / 2).toFixed(2),
    reorderPoint: String(Math.floor(between(0, 50))),
    type,
  });
}

// Opening stock: every stocked product; 1 in 20 has nothing on the shelf; every third row names the product by barcode.
const opening = products
  .filter((p) => p.type === 'SIMPLE')
  .map((p, n) => {
    const zero = n % 20 === 7;
    const quantity = zero ? '0' : p.unit === 'KG' || p.unit === 'LTR' ? between(0.5, 120).toFixed(3) : String(Math.floor(between(1, 500)));
    const byBarcode = n % 3 === 0 && p.barcode;
    return { sku: byBarcode ? '' : p.sku, barcode: byBarcode ? p.barcode : '', quantity, product: p };
  });

const customers = [];
for (let i = 1; i <= CUSTOMERS; i++) {
  const national = `7${pad(SEED % 100, 2)}${pad(i, 7)}`;
  const phone = i % 10 === 0 ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : i % 10 === 1 ? `0${national}` : national;
  const limit = 500 * Math.floor(between(2, 100));
  const r = rng();
  const balance = r < 0.6 ? Math.round(between(1, limit) * 100) / 100 : r < 0.65 ? -Math.round(between(1, 2000) * 100) / 100 : r < 0.8 ? 0 : null;
  customers.push({
    name: `Customer ${i}`,
    phone,
    national,
    email: i % 4 === 0 ? `customer${i}@example.test` : '',
    address: i % 3 === 0 ? `${i}, Main Road` : '',
    city: pick(['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Chennai', 'Mumbai']),
    state: pick(STATES),
    creditLimit: String(limit),
    openingBalance: balance === null ? '' : balance.toFixed(2),
    notes: i % 7 === 0 ? 'Pays on the 1st' : '',
  });
}

const files = {
  products: csv(['sku', 'name', 'category', 'barcode', 'hsnCode', 'unit', 'gstRate', 'cessRate', 'costPrice', 'sellingPrice', 'mrp', 'wholesalePrice', 'reorderPoint', 'type'],
    products.map((p) => [p.sku, p.name, p.category, p.barcode, p.hsnCode, p.unit, p.gstRate, p.cessRate, p.costPrice, p.sellingPrice, p.mrp, p.wholesalePrice, p.reorderPoint, p.type])),
  'opening-stock': csv(['sku', 'barcode', 'quantity'], opening.map((o) => [o.sku, o.barcode, o.quantity])),
  customers: csv(['name', 'phone', 'email', 'address', 'city', 'state', 'creditLimit', 'openingBalance', 'notes'],
    customers.map((c) => [c.name, c.phone, c.email, c.address, c.city, c.state, c.creditLimit, c.openingBalance, c.notes])),
};
for (const [kind, content] of Object.entries(files)) writeFileSync(join(filesDir, `${kind}.csv`), content);

// Expected figures, exact: quantity in thousandths × cost in paise.
const stocked = opening.filter((o) => Number(o.quantity) > 0);
const valueMilliPaise = stocked.reduce((s, o) => s + BigInt(Math.round(Number(o.quantity) * 1000)) * BigInt(Math.round(Number(o.product.costPrice) * 100)), 0n);
const expectedInventoryValue = Number((valueMilliPaise + 500n) / 1000n) / 100;
const expectedUdhar = customers.reduce((s, c) => s + Math.round(Number(c.openingBalance || 0) * 100), 0) / 100;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const checks = [];
const timings = {};
function check(id, pass, detail) {
  checks.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(34)} ${detail}`);
}
async function timed(id, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[id] = (Date.now() - started) / 1000;
  }
}
async function call(method, path, token, body) {
  const res = await fetch(`${target}/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

let token;
if (process.env.ONBOARDING_EMAIL && process.env.ONBOARDING_PASSWORD) {
  token = await login(target, process.env.ONBOARDING_EMAIL, process.env.ONBOARDING_PASSWORD);
} else {
  const suffix = randomUUID().slice(0, 8);
  const email = `onboarding-${suffix}@gate.local`;
  const password = `Onboarding-${suffix}-Gate!`;
  const registered = await call('POST', '/auth/register', undefined, { email, password, name: 'Onboarding Owner', shopName: `Onboarding gate ${suffix}` });
  if (registered.status !== 201) throw new Error(`registration failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  token = await login(target, email, password);
}
const client = importClient(target, token);

// Step 1 of the first day: the shop's state decides CGST/SGST against IGST.
const profile = await call('PATCH', '/shops/me', token, { state: 'Karnataka', city: 'Bengaluru', pincode: '560001', gstin: '29ABCDE1234F1Z5' });
check('shop profile with state', profile.status === 200 && profile.body?.state === 'Karnataka', `PATCH /shops/me -> ${profile.status}, state ${profile.body?.state}`);

const expected = {
  products: { rows: PRODUCTS, created: PRODUCTS, skipped: 0 },
  'opening-stock': { rows: opening.length, created: stocked.length, skipped: opening.length - stocked.length },
  customers: { rows: CUSTOMERS, created: CUSTOMERS, skipped: 0 },
};
const jobs = {};
for (const kind of ['products', 'opening-stock', 'customers']) {
  const want = expected[kind];
  const dry = await timed(`${kind} dry run`, async () => client.wait((await client.upload(kind, `${kind}.csv`, files[kind], { dryRun: true })).jobId, { timeoutMs: TIMEOUT_MS }));
  console.log(`      ${summarize(dry)}`);
  check(`${kind}: dry run plans every row`, dry.status === 'COMPLETED' && dry.totalRows === want.rows && dry.createdCount === want.created && dry.skippedCount === want.skipped && dry.errorRows === 0,
    `${dry.status}, ${dry.totalRows} rows, ${dry.createdCount} would create, ${dry.skippedCount} skipped, ${dry.errorRows} refused (${timings[`${kind} dry run`]} s)`);
  if (dry.errorRows > 0) console.log(JSON.stringify(await client.problems(dry.id, 5), null, 2));

  const applied = await timed(`${kind} apply`, async () => client.wait((await client.apply(dry.id)).jobId, { timeoutMs: TIMEOUT_MS }));
  console.log(`      ${summarize(applied)}`);
  check(`${kind}: apply creates every row`, applied.status === 'COMPLETED' && applied.createdCount === want.created && applied.skippedCount === want.skipped && applied.errorRows === 0,
    `${applied.status}, ${applied.createdCount} created, ${applied.skippedCount} skipped, ${applied.errorRows} refused (${timings[`${kind} apply`]} s)`);
  if (applied.errorRows > 0) console.log(JSON.stringify(await client.problems(applied.id, 5), null, 2));

  const rerun = await timed(`${kind} re-run`, async () => client.wait((await client.upload(kind, `${kind}.csv`, files[kind], { dryRun: false })).jobId, { timeoutMs: TIMEOUT_MS }));
  console.log(`      ${summarize(rerun)}`);
  check(`${kind}: re-run is all unchanged`, rerun.status === 'COMPLETED' && rerun.unchangedCount === want.created && rerun.skippedCount === want.skipped && rerun.createdCount + rerun.updatedCount + rerun.errorRows === 0,
    `${rerun.status}, ${rerun.unchangedCount} unchanged, ${rerun.createdCount} created, ${rerun.updatedCount} updated, ${rerun.errorRows} refused (${timings[`${kind} re-run`]} s)`);
  jobs[kind] = { dryRun: dry, apply: applied, rerun };
}

const recon = await timed('reconciliation', () => call('POST', '/reconciliation/run', token, {}));
check('reconciliation is CLEAN', recon.status === 201 && recon.body?.status === 'CLEAN', `POST /reconciliation/run -> ${recon.status} ${recon.body?.status}, ${recon.body?.driftCount} drift(s) (${timings.reconciliation} s)`);
if (recon.body?.status !== 'CLEAN') console.log(JSON.stringify(recon.body?.checks?.filter((c) => c.drifts?.length), null, 2)?.slice(0, 4000));

const summary = (await call('GET', '/dashboard/summary', token)).body ?? {};
check('dashboard: product count', summary.totalProducts === PRODUCTS, `totalProducts ${summary.totalProducts}, expected ${PRODUCTS}`);
check('dashboard: customer count', summary.totalCustomers === CUSTOMERS, `totalCustomers ${summary.totalCustomers}, expected ${CUSTOMERS}`);
check('dashboard: inventory value', Math.abs((summary.inventoryValue ?? NaN) - expectedInventoryValue) < 0.005, `inventoryValue ${summary.inventoryValue}, expected Σ quantity × cost = ${expectedInventoryValue.toFixed(2)}`);
check('dashboard: outstanding udhar', Math.abs((summary.outstandingUdhar ?? NaN) - expectedUdhar) < 0.005, `outstandingUdhar ${summary.outstandingUdhar}, expected Σ opening balances = ${expectedUdhar.toFixed(2)}`);

const failed = checks.filter((c) => !c.pass);
const report = {
  gate: 'roadmap 9.20 onboarding scale',
  target,
  ranAt: new Date().toISOString(),
  seed: SEED,
  files: filesDir,
  volumes: { products: PRODUCTS, openingStockRows: opening.length, stocked: stocked.length, customers: CUSTOMERS },
  expected: { inventoryValue: expectedInventoryValue, outstandingUdhar: expectedUdhar },
  timingsSeconds: timings,
  jobs,
  reconciliation: recon.body,
  checks,
  result: failed.length === 0 ? 'PASS' : 'FAIL',
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.result}: ${checks.length - failed.length}/${checks.length} checks; report ${reportPath}; files ${filesDir}`);
process.exit(failed.length === 0 ? 0 : 1);

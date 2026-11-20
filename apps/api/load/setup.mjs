// Prepares LOAD_SHOPS shops (default 16) for load/pos-peak.yml (roadmap 5.8)
// against a running API, through public routes only. Per shop: registers a
// user (registration creates the shop and its OWNER), logs in, creates a
// ZERO-GST product, stocks it through the same inventory-domain routes the
// web uses and opens a shift. The result goes to .state.json for
// processor.js, which spreads the virtual users over the shops: a checkout
// takes the shop's shift, number-sequence and product row locks, so one shop
// bills serially by design and the peak is a fleet figure. Needs LOAD_TARGET
// (API origin).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.env.LOAD_TARGET;
if (!target) throw new Error('LOAD_TARGET is required (e.g. http://127.0.0.1:3019)');
const base = `${target.replace(/\/$/, '')}/api`;
const unitPrice = 20;
const openingStock = Number(process.env.LOAD_OPENING_STOCK ?? 1_000_000);

async function call(method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return json;
}

const shopCount = Number(process.env.LOAD_SHOPS ?? 16);
const shops = [];
{
  for (let i = 0; i < shopCount; i++) {
    const suffix = randomUUID().slice(0, 8);
    const email = `load-${suffix}@load.local`;
    const password = `Load-${suffix}-Passw0rd!`;

    const registered = await call('POST', '/auth/register', { email, password, name: 'Load Owner', shopName: `Load shop ${suffix}` });
    if (registered?.role !== 'OWNER') throw new Error(`registration did not create an OWNER (got ${registered?.role})`);

    const login = await call('POST', '/auth/login', { email, password });
    const token = login.access_token;

    const product = await call('POST', '/products', {
      name: `Load product ${suffix}`,
      sku: `LOAD-${suffix}`,
      costPrice: 10,
      sellingPrice: unitPrice,
      mrp: 25,
      wholesalePrice: 15,
      unit: 'PCS',
      gstRate: 'ZERO',
    }, token);

    const item = await call('POST', '/inventory-domain', { productId: product.id }, token);
    await call('POST', `/inventory-domain/${item.id}/adjust`, { reason: 'OPENING_BALANCE', quantityChange: openingStock, notes: 'load test opening stock' }, token);
    await call('POST', '/shifts/open', { openingCash: 0 }, token);
    shops.push({ suffix, email, password, token, productId: product.id });
  }
}

const state = { target, unitPrice, shops, preparedAt: new Date().toISOString() };
const file = process.env.LOAD_STATE_FILE || join(dirname(fileURLToPath(import.meta.url)), '.state.json');
writeFileSync(file, JSON.stringify(state, null, 2));
console.log(`load state written to ${file}: ${shops.length} shop(s) [${shops.map((s) => s.suffix).join(', ')}], ${openingStock} units each`);

#!/usr/bin/env node
// Product photo round trip for deploy/azure/e2e.sh, over the public API:
// registers an owner, creates a product, uploads PHOTO with
// POST /media/upload/product/:id and reads it back from
// GET /media/assets/:id/file, comparing SHA-256. With --repeat N --every S it
// keeps uploading (the memory load). One JSON line per round; exit 1 on any
// failure or mismatch.
//
//   E2E_API_URL=https://api.localhost:18443/api node deploy/azure/e2e/upload.mjs PHOTO [--repeat N] [--every SECONDS]
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = (process.env.E2E_API_URL ?? '').replace(/\/$/, '');
const [photoPath, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i === -1 ? fallback : Number(rest[i + 1]);
};
const repeat = flag('--repeat', 1);
const everyMs = flag('--every', 0) * 1000;
if (!API || !photoPath) {
  console.error('usage: E2E_API_URL=... node upload.mjs PHOTO [--repeat N] [--every SECONDS]');
  process.exit(2);
}
const photo = readFileSync(photoPath);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const fail = (msg) => {
  console.error(`UPLOAD FAILED: ${msg}`);
  process.exit(1);
};

async function call(method, path, { body, token, form } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = undefined;
  }
  return { status: res.status, json, buf, type: res.headers.get('content-type') };
}
const must = (label, want, res) => {
  if (res.status !== want) fail(`${label}: HTTP ${res.status}, expected ${want}: ${res.buf.toString('utf8').slice(0, 400)}`);
  return res.json;
};

const suffix = randomBytes(4).toString('hex');
const email = `photo-${suffix}@e2e.local`;
const password = `Photo-${suffix}-Passw0rd!`;
must('register', 201, await call('POST', '/auth/register', { body: { email, password, name: 'Photo Owner', shopName: `Photo shop ${suffix}` } }));
const token = must('login', 201, await call('POST', '/auth/login', { body: { email, password } }))?.access_token;
const product = must('create product', 201, await call('POST', '/products', {
  token,
  body: { name: 'Photo tea', sku: `PHOTO-${suffix}`, costPrice: 10, sellingPrice: 20, mrp: 25, wholesalePrice: 15, unit: 'PCS', gstRate: 'ZERO' },
}));

for (let round = 1; round <= repeat; round += 1) {
  const started = Date.now();
  const form = new FormData();
  form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  const asset = must('upload', 201, await call('POST', `/media/upload/product/${product.id}`, { token, form }));
  const back = await call('GET', `/media/assets/${asset.id}/file`, { token });
  if (back.status !== 200) fail(`download: HTTP ${back.status}`);
  const line = { round, assetId: asset.id, productId: product.id, bytes: back.buf.length, type: back.type, sha256Sent: sha(photo), sha256Received: sha(back.buf), ms: Date.now() - started };
  console.log(JSON.stringify(line));
  if (line.sha256Sent !== line.sha256Received) fail(`round ${round}: the file read back differs from the one uploaded`);
  if (round < repeat && everyMs > 0) await new Promise((r) => setTimeout(r, everyMs));
}

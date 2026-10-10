#!/usr/bin/env node
// Pilot readiness (roadmap 9.19): what the pilot shop's day 1 needs from a
// deployed environment, checked from outside before anyone drives to the
// shop. Read-only: no email is sent, the OCR model is never called, nothing
// is created (with owner credentials it signs in once and signs out again).
//
//   node scripts/pilot/readiness.mjs --web https://staging-app.example.in --api https://staging-api.example.in
//   PILOT_OWNER_EMAIL=... PILOT_OWNER_PASSWORD=... node scripts/pilot/readiness.mjs --web ... --api ... --json out.json
//
// Every check prints PASS, WARN or FAIL with what it saw; the exit code is 1
// when any check FAILs. docs/PILOT.md lists what each one protects.
//
//   --web URL       the web origin the shop opens
//   --api URL       the API origin (without /api)
//   --json FILE     also write the results as JSON
//   --timeout SEC   per request (default 20)
//   Owner checks (shop profile, OCR key, session lifetime) run when
//   PILOT_OWNER_EMAIL and PILOT_OWNER_PASSWORD are set. A self-signed edge:
//   NODE_EXTRA_CA_CERTS=ca.pem.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
if (args.includes('-h') || args.includes('--help')) {
  console.log('usage: readiness.mjs --web <origin> --api <origin> [--json FILE] [--timeout SEC]');
  process.exit(0);
}
const WEB = (opt('web') ?? '').replace(/\/$/, '');
const API = (opt('api') ?? '').replace(/\/$/, '');
const TIMEOUT_MS = Number(opt('timeout') ?? 20) * 1000;
if (!WEB || !API) {
  console.error('usage: readiness.mjs --web <origin> --api <origin> [--json FILE] [--timeout SEC]');
  process.exit(2);
}

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  console.log(`${status.padEnd(4)}  ${id.padEnd(18)} ${detail}`);
}

async function call(method, url, { body, form, token, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  } catch (err) {
    return { status: 0, text: String(err?.cause?.code ?? err?.message ?? err), json: undefined, headers: new Headers() };
  }
}

const answer = (r) => (r.status ? `HTTP ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}` : `no answer (${r.text})`);
const meta = (html, name) => new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`).exec(html)?.[1];

// ---- transport -------------------------------------------------------------
for (const [id, origin] of [['web-https', WEB], ['api-https', API]]) {
  if (origin.startsWith('https://')) record(id, 'PASS', `${origin} is HTTPS`);
  else record(id, 'FAIL', `${origin} is not HTTPS: the shop's browser sends passwords and the session cookie over it`);
}

// ---- probes ----------------------------------------------------------------
const webLive = await call('GET', `${WEB}/api/health`);
record('web-live', webLive.status === 200 ? 'PASS' : 'FAIL', `GET ${WEB}/api/health -> ${answer(webLive)}`);
const apiReady = await call('GET', `${API}/api/health/ready`);
record('api-ready', apiReady.status === 200 ? 'PASS' : 'FAIL', `GET ${API}/api/health/ready -> ${answer(apiReady)}${apiReady.json?.status ? ` (${apiReady.json.status})` : ''}`);

// ---- what the browser is told at run time (roadmap 9.9, 9.19) ----------------
const login = await call('GET', `${WEB}/login`);
const browserApi = meta(login.text, 'dukaanai-api-url');
if (login.status !== 200) record('web-api-url', 'FAIL', `GET ${WEB}/login -> ${answer(login)}`);
else if (browserApi === `${API}/api`) record('web-api-url', 'PASS', `the web tells browsers to use ${browserApi}`);
else record('web-api-url', 'FAIL', `the web tells browsers to use ${browserApi ?? '(no meta)'}, expected ${API}/api (API_PUBLIC_URL)`);

const googleWeb = meta(login.text, 'dukaanai-google-signin');
// A well-formed but unsigned id token: the API decides on its configuration before it ever trusts the token.
const unsigned = ['{"alg":"RS256","typ":"JWT"}', '{"sub":"readiness"}'].map((p) => Buffer.from(p).toString('base64url')).join('.') + '.c2ln';
const googleApi = await call('POST', `${API}/api/auth/google`, { body: { idToken: unsigned } });
const apiGoogle = googleApi.json?.code === 'GOOGLE_SIGNIN_NOT_CONFIGURED' ? 'off' : googleApi.status === 401 || googleApi.status === 400 ? 'on' : 'unknown';
if (googleWeb === undefined) record('google-signin', 'FAIL', 'the web renders no dukaanai-google-signin meta (a build from before 9.19)');
else if (apiGoogle === 'unknown') record('google-signin', 'FAIL', `POST /api/auth/google answered ${answer(googleApi)}; expected 503 GOOGLE_SIGNIN_NOT_CONFIGURED or 401`);
else if ((googleWeb === 'on') !== (apiGoogle === 'on'))
  record('google-signin', 'FAIL', `half configured: the web offers Google ${googleWeb}, the API verifies tokens ${apiGoogle}; set the same GOOGLE_CLIENT_ID on both (and GOOGLE_CLIENT_SECRET on the web)`);
else record('google-signin', googleWeb === 'on' ? 'PASS' : 'WARN', googleWeb === 'on' ? 'offered by the web and verified by the API' : 'off on both sides (the pilot checklist has a Google sign-in row)');

// ---- email: invitations and reset links (production refuses without SMTP) ---
const nobody = `pilot-readiness-${Date.now().toString(36)}@example.invalid`;
const forgot = await call('POST', `${API}/api/auth/forgot-password`, { body: { email: nobody } });
if (forgot.status === 200) record('email', 'PASS', 'forgot-password answers 200: the API has a mail relay, or runs outside NODE_ENV=production in log mode (send a real invitation to prove delivery)');
else if (forgot.status === 503) record('email', 'FAIL', 'forgot-password answers 503: SMTP_URL is not set, so invitations and reset links cannot be sent');
else record('email', 'FAIL', `forgot-password answered ${answer(forgot)}`);

// ---- the scrape endpoint must not be public (roadmap 9.8) ---------------------
const metrics = await call('GET', `${API}/api/metrics`);
if (metrics.status === 404 || metrics.status === 401) record('metrics-hidden', 'PASS', `GET /api/metrics from outside -> ${answer(metrics)}`);
else record('metrics-hidden', 'FAIL', `GET /api/metrics from outside -> ${answer(metrics)}: the metrics endpoint is reachable from the internet`);

// ---- owner checks --------------------------------------------------------------
const ownerEmail = process.env.PILOT_OWNER_EMAIL;
const ownerPassword = process.env.PILOT_OWNER_PASSWORD;
if (!ownerEmail || !ownerPassword) {
  record('owner-checks', 'WARN', 'skipped: set PILOT_OWNER_EMAIL and PILOT_OWNER_PASSWORD for the shop profile, OCR key and session lifetime checks');
} else {
  const signedIn = await call('POST', `${API}/api/auth/login`, { body: { email: ownerEmail, password: ownerPassword } });
  const token = signedIn.json?.access_token;
  if (!token) {
    record('owner-login', 'FAIL', `POST /api/auth/login -> ${answer(signedIn)}`);
  } else {
    record('owner-login', 'PASS', `signed in as ${ownerEmail} (${signedIn.json?.user?.role ?? 'role unknown'})`);
    const shop = await call('GET', `${API}/api/shops/me`, { token });
    const profile = shop.json ?? {};
    const missing = ['name', 'state', 'address', 'phone'].filter((key) => !profile[key]);
    const gstin = profile.gstin ?? profile.settings?.gstin;
    const zone = profile.timezone ?? profile.settings?.timezone;
    if (shop.status !== 200) record('shop-profile', 'FAIL', `GET /api/shops/me -> ${answer(shop)}`);
    else if (missing.length) record('shop-profile', 'FAIL', `the receipt and the GST split need ${missing.join(', ')} in Settings > Shop Profile (state decides IGST)`);
    else record('shop-profile', 'PASS', `${profile.name}, ${profile.state}${gstin ? `, GSTIN ${gstin}` : ', no GSTIN (receipts print without one)'}${zone ? `, ${zone}` : ''}`);

    // A tiny non-image upload: an unconfigured server answers 503 before reading it, a configured one 400 after sniffing it. The model is never called.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('pilot readiness: not an image')], { type: 'image/jpeg' }), 'readiness.jpg');
    form.append('documentType', 'BILL');
    const ocr = await call('POST', `${API}/api/ocr/scan-bill`, { token, form });
    if (ocr.json?.code === 'OCR_NOT_CONFIGURED') record('ocr', 'FAIL', 'the AI scanner answers 503 OCR_NOT_CONFIGURED: set GEMINI_API_KEY on the API');
    else if (ocr.status === 400) record('ocr', 'PASS', `a key is configured (${answer(ocr)} for a non-image; scan a real bill to prove the key works)`);
    else record('ocr', 'FAIL', `POST /api/ocr/scan-bill -> ${answer(ocr)}`);

    const sessions = await call('GET', `${API}/api/auth/sessions?take=1`, { token });
    const newest = Array.isArray(sessions.json) ? sessions.json[0] : undefined;
    if (newest?.createdAt && newest?.absoluteExpiresAt) {
      const hours = (Date.parse(newest.absoluteExpiresAt) - Date.parse(newest.createdAt)) / 3_600_000;
      if (hours > 24)
        record('session-lifetime', 'FAIL', `a sign-in lasts ${hours.toFixed(1)} h: SESSION_ABSOLUTE_LIFETIME is past the reviewed 12 h (ASVS 3.3.2, docs/security/ASVS_L2.md); an image from before 9.19 ran 30 days`);
      else record('session-lifetime', 'PASS', `a sign-in lasts at most ${hours.toFixed(1)} h (SESSION_ABSOLUTE_LIFETIME): a cashier signs in again after that, mid-shift if the day is longer`);
    } else record('session-lifetime', 'WARN', `GET /api/auth/sessions -> ${answer(sessions)}`);

    await call('POST', `${API}/api/auth/logout`, { token, body: { refresh_token: signedIn.json?.refresh_token } });
  }
}

const failed = results.filter((r) => r.status === 'FAIL').length;
const warned = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${failed ? 'NOT READY' : 'READY'}: ${results.length - failed - warned} pass, ${warned} warn, ${failed} fail`);
const out = opt('json');
if (out) writeFileSync(out, `${JSON.stringify({ web: WEB, api: API, at: new Date().toISOString(), results }, null, 2)}\n`);
process.exit(failed ? 1 : 0);

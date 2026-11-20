#!/usr/bin/env node
// Onboarding imports from the command line (roadmap 9.20): the first-day
// procedure of docs/ONBOARDING.md without a browser. Every import is a dry
// run first; `--apply` applies it only when the dry run refused no row
// (`--allow-errors` applies the valid rows anyway).
//
//   node scripts/onboarding/import.mjs template products --api https://api.example.in --out products.csv
//   ONBOARDING_EMAIL=owner@shop.in ONBOARDING_PASSWORD=... \
//     node scripts/onboarding/import.mjs products products.csv --api https://api.example.in --report dry-run.csv
//   ... node scripts/onboarding/import.mjs products products.csv --api ... --apply
//
//   kinds           products | customers | opening-stock (import them in that order:
//                   opening stock names products that must already exist)
//   --api URL       the API origin (without /api)
//   --apply         apply the dry run when it refused no row
//   --allow-errors  apply the valid rows of a dry run that refused some
//   --mode MODE     UPSERT (default) | CREATE_ONLY | UPDATE_ONLY
//   --report FILE   write the per-row report (CSV) of the last run
//   --json FILE     write the job summaries as JSON
//   --timeout SEC   how long to wait for one job (default 1800)
//   Credentials: ONBOARDING_TOKEN, or ONBOARDING_EMAIL + ONBOARDING_PASSWORD
//   (a MANAGER, ADMIN or OWNER of the shop). Exit 0 when every row is in the
//   shop, 2 when rows were refused (see the report), 1 on any other failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KINDS = ['products', 'customers', 'opening-stock'];

/** A small client over the import routes; `api` is the origin without /api. */
export function importClient(api, token, { requestTimeoutMs = 60_000 } = {}) {
  const base = `${api.replace(/\/$/, '')}/api`;
  async function call(method, path, { body, form, raw = false } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(requestTimeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    if (raw) return { text, headers: res.headers };
    return text ? JSON.parse(text) : undefined;
  }
  return {
    call,
    template: async (kind) => (await call('GET', `/imports/templates/${kind}`, { raw: true })).text,
    upload: async (kind, fileName, content, { dryRun = true, mode } = {}) => {
      const form = new FormData();
      form.append('file', new Blob([content], { type: 'text/csv' }), fileName);
      form.append('dryRun', dryRun ? 'true' : 'false');
      if (mode) form.append('mode', mode);
      return call('POST', `/imports/${kind}/upload`, { form });
    },
    apply: (jobId) => call('POST', `/imports/jobs/${jobId}/apply`),
    job: (jobId) => call('GET', `/imports/jobs/${jobId}`),
    report: async (jobId) => (await call('GET', `/imports/jobs/${jobId}/report`, { raw: true })).text,
    problems: (jobId, take = 20) => call('GET', `/imports/jobs/${jobId}/rows?status=ERROR&take=${take}`),
    /** Polls until the job leaves PENDING / PROCESSING; `onProgress` sees each read. */
    wait: async (jobId, { timeoutMs = 1_800_000, intervalMs = 1000, onProgress } = {}) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await call('GET', `/imports/jobs/${jobId}`);
        onProgress?.(job);
        if (job.status !== 'PENDING' && job.status !== 'PROCESSING') return job;
        if (Date.now() > deadline) throw new Error(`import job ${jobId} still ${job.status} after ${Math.round(timeoutMs / 1000)} s`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
}

/** Signs in with email and password (the API's own login) and returns the access token. */
export async function login(api, email, password) {
  const res = await fetch(`${api.replace(/\/$/, '')}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`sign-in failed (${res.status}): ${body.message ?? 'no access token'}`);
  return body.access_token;
}

/** One line per job: what the run did (or would do) with the file's rows. */
export function summarize(job) {
  const verb = job.dryRun ? 'would create' : 'created';
  return `${job.dryRun ? 'dry run' : 'import'} ${job.id} ${job.status}: ${job.totalRows} rows, ${job.createdCount} ${verb}, ${job.updatedCount} ${job.dryRun ? 'would update' : 'updated'}, ${job.unchangedCount} unchanged, ${job.skippedCount} skipped, ${job.errorRows} refused`;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const flag = (name) => args.includes(`--${name}`);
  const usage = 'usage: import.mjs <products|customers|opening-stock> <file.csv> --api URL [--apply] [--allow-errors] [--mode MODE] [--report FILE] [--json FILE]\n       import.mjs template <kind> --api URL [--out FILE]';
  if (flag('help') || args.includes('-h') || args.length === 0) {
    console.log(usage);
    process.exit(0);
  }
  const api = opt('api');
  if (!api) {
    console.error(usage);
    process.exit(1);
  }
  const token = process.env.ONBOARDING_TOKEN || (process.env.ONBOARDING_EMAIL && process.env.ONBOARDING_PASSWORD ? await login(api, process.env.ONBOARDING_EMAIL, process.env.ONBOARDING_PASSWORD) : undefined);
  if (!token) throw new Error('set ONBOARDING_TOKEN, or ONBOARDING_EMAIL and ONBOARDING_PASSWORD');
  const client = importClient(api, token);

  if (args[0] === 'template') {
    const kind = args[1];
    if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}; use ${KINDS.join(', ')}`);
    const csv = await client.template(kind);
    const out = opt('out');
    if (out) writeFileSync(out, csv);
    else process.stdout.write(csv);
    return 0;
  }

  const [kind, file] = args;
  if (!KINDS.includes(kind) || !file) throw new Error(usage);
  const mode = opt('mode');
  const timeoutMs = Number(opt('timeout') ?? 1800) * 1000;
  const progress = (job) => {
    if (job.status === 'PROCESSING' && job.totalRows > 0) process.stderr.write(`\r  ${job.validRows + job.errorRows}/${job.totalRows} rows`);
  };
  const jobs = [];

  const queued = await client.upload(kind, basename(file), readFileSync(file), { dryRun: true, mode });
  const dry = await client.wait(queued.jobId, { timeoutMs, onProgress: progress });
  process.stderr.write('\n');
  console.log(summarize(dry));
  jobs.push(dry);
  let last = dry;

  const refused = await client.problems(dry.id);
  for (const row of refused) {
    const problems = (row.errors ?? []).filter((i) => i.severity === 'error').map((i) => `${i.field ? `${i.field}: ` : ''}${i.message}`);
    console.log(`  ${row.rowNumber === 0 ? 'file' : `row ${row.rowNumber}`}: ${problems.join('; ')}`);
  }
  if (dry.errorRows > refused.length) console.log(`  ... and ${dry.errorRows - refused.length} more (see --report)`);

  let exit = dry.status === 'FAILED' ? 2 : dry.errorRows > 0 ? 2 : 0;
  if (flag('apply') && dry.status !== 'FAILED') {
    if (dry.errorRows > 0 && !flag('allow-errors')) {
      console.log('not applied: fix the refused rows (or pass --allow-errors to import the valid ones)');
    } else {
      const applied = await client.apply(dry.id);
      last = await client.wait(applied.jobId, { timeoutMs, onProgress: progress });
      process.stderr.write('\n');
      console.log(summarize(last));
      jobs.push(last);
      exit = last.status === 'COMPLETED' ? 0 : 2;
    }
  }

  const report = opt('report');
  if (report) {
    writeFileSync(report, await client.report(last.id));
    console.log(`report: ${report}`);
  }
  const json = opt('json');
  if (json) writeFileSync(json, `${JSON.stringify(jobs, null, 2)}\n`);
  return exit;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

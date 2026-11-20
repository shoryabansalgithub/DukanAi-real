import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { shopPathOf } from './cross-shop-audit';

/**
 * Raw SQL is the one way past the tenant extension (`src/prisma/tenant-scope.ts`
 * narrows every Prisma model call to the caller's shop; `$queryRaw` and
 * `$executeRaw` are sent as written). So every raw statement in `src/` that
 * touches a table a shop owns must name the shop, or be listed here with the
 * reason it may span shops (cross-shop isolation audit, 2026-10-12). A
 * statement on tables no shop owns (`_prisma_migrations`, `SELECT 1`) passes
 * on its own. The cross-shop integration suite then proves the behaviour; this
 * spec keeps a new unscoped statement from arriving unnoticed.
 */

interface Allowed {
  file: string;
  /** A fragment of the statement, unique enough to name it. */
  contains: string;
  reason: string;
}

const ALLOWED: Allowed[] = [
  { file: 'src/analytics-domain/services/dashboard.service.ts', contains: 'WHERE ${filter}', reason: 'the stock alert queries take `stockAlertProductFilter(shopId)`, a Prisma.sql fragment that names the shop' },
  { file: 'src/common/numbering/number-sequence.service.ts', contains: 'UPDATE NumberSequence SET lastNumber', reason: 'by the id of the row the same transaction just read FOR UPDATE under the shop' },
  { file: 'src/common/observability/observability-collectors.service.ts', contains: 'FROM OutboxEvent GROUP BY status', reason: 'platform metric: counts per status, no row leaves the process' },
  { file: 'src/common/observability/observability-collectors.service.ts', contains: 'SELECT MIN(createdAt) AS createdAt FROM OutboxEvent', reason: 'platform metric: the age of the oldest open row, no row leaves the process' },
  { file: 'src/common/outbox/outbox-claim.service.ts', contains: "SET status = 'CLAIMED'", reason: 'relays span shops by design: the ids are the rows this claim selected; each worker then runs the row in its own shop context' },
  { file: 'src/common/outbox/outbox-claim.service.ts', contains: "SET status = 'PENDING', claimedAt = NULL", reason: 'releases the rows this claim took (by id) after an enqueue failure' },
  { file: 'src/common/outbox/outbox-reaper.service.ts', contains: 'SELECT id, retryCount, status FROM OutboxEvent', reason: 'the reaper is a system job over every shop: stale claims go back to PENDING with their shopId untouched' },
  { file: 'src/common/outbox/outbox-reaper.service.ts', contains: "UPDATE OutboxEvent SET status = 'FAILED'", reason: 'the reaper, by the ids it selected' },
  { file: 'src/common/outbox/outbox-reaper.service.ts', contains: "UPDATE OutboxEvent SET status = 'PENDING'", reason: 'the reaper, by the ids it selected' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM RefreshToken', reason: 'retention purges by age across every shop (roadmap 7.8); nothing is read back' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM PasswordResetToken', reason: 'retention purge by age' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM OutboxEvent', reason: 'retention purge by age' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM SearchHistory', reason: 'retention purge by age' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM ProductEventLog', reason: 'retention purge by age' },
  { file: 'src/common/retention/retention-sweep.service.ts', contains: 'DELETE FROM WebhookDelivery', reason: 'retention purge by age' },
  { file: 'src/inventory-domain/services/inventory-mutation.engine.ts', contains: 'SELECT id FROM Product WHERE id = ${id}', reason: "tells another shop's product from a missing one to raise TenantViolationError (an invariant); nothing is returned to the caller" },
  { file: 'src/prisma/cross-shop-audit.ts', contains: 'SELECT COUNT(*) AS n ${where}', reason: 'the cross-shop audit spans shops by design and only reads' },
  { file: 'src/prisma/cross-shop-audit.ts', contains: 'SELECT ${check.keySelect}', reason: 'the cross-shop audit report: key columns and the two shop ids of a finding' },
  { file: 'src/privacy/shop-data.ts', contains: 'SELECT t0.* FROM ${scope.from} WHERE ${scope.where}', reason: "the export reads each model through its shop path (`childModels`), and `scope.where` always binds the shop's id" },
];

const SRC = path.resolve(__dirname, '..');
const ROOT = path.resolve(SRC, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

interface Statement {
  file: string;
  line: number;
  text: string;
}

/** Every `$queryRaw`/`$executeRaw` (and the Unsafe forms) with its SQL: the template literal, or the call's first argument. */
function rawStatements(): Statement[] {
  const found: Statement[] = [];
  const call = /\$(queryRaw|executeRaw)(Unsafe)?\s*(<[^`(]*?>)?\s*(`|\()/g;
  for (const full of sourceFiles(SRC)) {
    const src = readFileSync(full, 'utf8');
    for (let m = call.exec(src); m; m = call.exec(src)) {
      const opener = m.index + m[0].length - 1;
      let end = opener + 1;
      if (m[4] === '`') {
        for (let depth = 0; end < src.length; end++) {
          if (src[end] === '\\') end++;
          else if (src[end] === '$' && src[end + 1] === '{') depth++;
          else if (src[end] === '}' && depth > 0) depth--;
          else if (src[end] === '`' && depth === 0) break;
        }
      } else {
        for (let depth = 1; end < src.length && depth > 0; end++) {
          if (src[end] === '(') depth++;
          else if (src[end] === ')') depth--;
        }
      }
      found.push({ file: path.relative(ROOT, full).split(path.sep).join('/'), line: src.slice(0, m.index).split('\n').length, text: src.slice(opener, end + 1).replace(/\s+/g, ' ') });
    }
  }
  return found;
}

/** The tables a statement names after FROM, JOIN, UPDATE, INTO; null when one of them is computed (`${...}`). */
function tablesOf(text: string): string[] | null {
  const tables: string[] = [];
  for (const m of text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(`?)([A-Za-z_$][\w${}.]*)\1/gi)) {
    if (m[2].includes('${')) return null;
    tables.push(m[2]);
  }
  return tables;
}

const ownedByShops = (table: string) => shopPathOf(table, 't') !== null;

describe('raw SQL names the shop (cross-shop isolation audit)', () => {
  const statements = rawStatements();
  const allowedFor = (s: Statement) => ALLOWED.find((a) => a.file === s.file && s.text.includes(a.contains));

  it('finds the raw statements of the API (the scan works)', () => {
    expect(statements.length).toBeGreaterThan(80);
    expect(statements.some((s) => s.file === 'src/common/numbering/number-sequence.service.ts')).toBe(true);
  });

  it('every raw statement on a shop-owned table names the shop, or is listed with its reason', () => {
    const unscoped = statements.filter((s) => {
      if (/shopId/i.test(s.text) || allowedFor(s)) return false;
      const tables = tablesOf(s.text);
      return tables === null || tables.some(ownedByShops);
    });
    expect(unscoped.map((s) => `${s.file}:${s.line} ${s.text.slice(0, 160)}`)).toEqual([]);
  });

  it('every listed exception still exists and is still unscoped (no stale entry)', () => {
    const stale = ALLOWED.filter((a) => !statements.some((s) => s.file === a.file && s.text.includes(a.contains) && !/shopId/i.test(s.text)));
    expect(stale.map((a) => `${a.file}: ${a.contains}`)).toEqual([]);
    for (const a of ALLOWED) expect(a.reason.length).toBeGreaterThan(20);
  });
});

import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

/**
 * Stock has one writer: `InventoryMutationEngine.mutateStock` (contract §4,
 * AGENTS.md "POS / billing architecture"). This scan replaces the former
 * `ci/check-inventory-authority.ts`, which no job ever ran (roadmap 8.4): it
 * walks every application source file (specs excluded) and fails on a write
 * to the stock authorities outside the engine:
 *
 *  - a Prisma write on `inventoryItem` or `inventoryLog` (the ledger);
 *  - raw SQL that updates or inserts into InventoryItem, Product or
 *    ProductVariant, wherever the statement starts (the old per-line check
 *    missed a multi-line template literal);
 *  - a Prisma `product` / `productVariant` update whose data touches
 *    `currentStock`.
 *
 * The allowlist names the exemptions with their reason; extending it is a
 * contract change, not a convenience.
 */
const SRC = path.resolve(__dirname, '..');

const ALLOWED: Record<string, string> = {
  'inventory-domain/services/inventory-mutation.engine.ts': 'the stock authority itself',
  'inventory/inventory-recon.service.ts':
    'repairs Product.currentStock from the ledger and records the correction as an InventoryLog row (roadmap 3.8)',
};

const PRISMA_STOCK_WRITE = /\.(inventoryItem|inventoryLog)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g;
const RAW_STOCK_SQL = /\b(UPDATE\s+(InventoryItem|Product|ProductVariant)|INSERT\s+INTO\s+(InventoryItem|InventoryLog))\b/g;
const PRODUCT_WRITE = /\.(product|productVariant)\.(update|updateMany|upsert)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The text of the call whose opening parenthesis is at `open` (balanced). */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

function violationsIn(relative: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(PRISMA_STOCK_WRITE)) {
    found.push(`${relative}:${lineOf(source, match.index ?? 0)} ${match[0].trim()}`);
  }
  for (const match of source.matchAll(RAW_STOCK_SQL)) {
    found.push(`${relative}:${lineOf(source, match.index ?? 0)} raw ${match[0].replace(/\s+/g, ' ')}`);
  }
  for (const match of source.matchAll(PRODUCT_WRITE)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (/\bcurrentStock\b/.test(callArguments(source, open))) {
      found.push(`${relative}:${lineOf(source, match.index ?? 0)} ${match[0]} writes currentStock`);
    }
  }
  return found;
}

describe('stock is written only by InventoryMutationEngine (roadmap 8.4)', () => {
  const files = sourceFiles(SRC).map((file) => ({ file, relative: path.relative(SRC, file).split(path.sep).join('/') }));

  it('no application source outside the allowlist writes InventoryItem, InventoryLog or currentStock', () => {
    const offenders = files
      .filter(({ relative }) => !(relative in ALLOWED))
      .flatMap(({ file, relative }) => violationsIn(relative, readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still exists and still writes stock (a stale entry hides a regression)', () => {
    for (const relative of Object.keys(ALLOWED)) {
      const entry = files.find((f) => f.relative === relative);
      expect(entry).toBeDefined();
      expect(violationsIn(relative, readFileSync(entry!.file, 'utf8')).length).toBeGreaterThan(0);
    }
  });
});

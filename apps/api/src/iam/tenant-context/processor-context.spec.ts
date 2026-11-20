/**
 * Roadmap 4.1 (audit P2-5): every BullMQ processor that touches Prisma runs
 * its job under a tenant context. Without one the tenant extension refuses
 * every tenant-model query ("Missing tenant context"), so a worker either
 * establishes the shop (`runWithContext(jobContext(...))`, `runInShopOf`)
 * or declares system-wide work (`runAsSuperAdmin`). This spec scans the
 * source of every `@Processor` class, so a new worker cannot regress it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..');
const CONTEXT_MARKERS = ['runWithContext(', 'runInShopOf(', 'runAsSuperAdmin(', 'sweepEveryShop('];
/** Processors that never query the database (Redis broadcast, queue hand-off only), with the reason. */
const NO_DATABASE = new Set<string>([
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('BullMQ processors run under a tenant context', () => {
  const processors = walk(SRC).filter((file) => /@Processor\(/.test(fs.readFileSync(file, 'utf8')));

  it('finds the processors', () => {
    // Eight live processors after the 4.5-4.9 removals; a drop below this means a worker file went missing.
    expect(processors.length).toBeGreaterThanOrEqual(8);
  });

  it.each(processors.map((file) => [path.relative(SRC, file)]))('%s establishes a context before touching the database', (rel) => {
    const source = fs.readFileSync(path.join(SRC, rel), 'utf8');
    if (NO_DATABASE.has(rel)) return;
    // Injected repositories, Prisma, or any call on an injected collaborator other than the logger.
    const touchesDatabase = /PrismaService|Repository\b/.test(source) || /this\.(?!logger\b)\w+\.\w+\(/.test(source);
    if (!touchesDatabase) return;
    const hasContext = CONTEXT_MARKERS.some((marker) => source.includes(marker));
    expect({ file: rel, hasContext }).toEqual({ file: rel, hasContext: true });
  });
});

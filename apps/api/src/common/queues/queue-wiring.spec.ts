/**
 * Static counterpart of `QueueWiringAssertion` (roadmap 4.6): over the
 * source files reachable from `app.module.ts` through relative imports,
 * every BullMQ queue that is registered must have a `@Processor` (consumer)
 * and an `@InjectQueue` (producer), and every producer or consumer must name
 * a registered queue. A queue without a producer is dead code; one without a
 * consumer collects jobs in Redis for good. Files that are not reachable from
 * the application module are ignored, so a stack detached from `AppModule`
 * cannot keep a queue alive.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const ENTRY = path.join(SRC, 'app.module.ts');

/** Consumers with no producer in this code base, each with its reason. */
const PRODUCER_ALLOWLIST: Record<string, string> = {};

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && !candidate.endsWith('.spec.ts')) return candidate;
  }
  return null;
}

function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[1]);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen];
}

/** Resolves `'literal'` or an identifier declared as `export const NAME = 'literal'` in the same or an imported file. */
function queueName(expr: string, file: string, source: string): string {
  const literal = expr.match(/^['"`]([^'"`]+)['"`]$/);
  if (literal) return literal[1];
  const ident = expr.trim();
  const local = source.match(new RegExp(`const\\s+${ident}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`));
  if (local) return local[1];
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!match[1].split(',').map((s) => s.trim()).includes(ident)) continue;
    const target = resolveImport(file, match[2]);
    if (!target) continue;
    const found = fs.readFileSync(target, 'utf8').match(new RegExp(`const\\s+${ident}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`));
    if (found) return found[1];
  }
  throw new Error(`Cannot resolve queue name ${ident} in ${path.relative(SRC, file)}`);
}

interface Wiring {
  registered: Map<string, string[]>;
  consumers: Map<string, string[]>;
  producers: Map<string, string[]>;
}

function inventory(): Wiring {
  const wiring: Wiring = { registered: new Map(), consumers: new Map(), producers: new Map() };
  const add = (map: Map<string, string[]>, name: string, file: string) => map.set(name, [...(map.get(name) ?? []), path.relative(SRC, file)]);
  for (const file of reachableFiles(ENTRY)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const block of source.matchAll(/registerQueue(?:Async)?\(([\s\S]*?)\)\s*[,\]]/g)) {
      for (const name of block[1].matchAll(/name:\s*([^,}\s]+)/g)) add(wiring.registered, queueName(name[1], file, source), file);
    }
    for (const match of source.matchAll(/@Processor\(\s*([^,)]+)/g)) add(wiring.consumers, queueName(match[1], file, source), file);
    for (const match of source.matchAll(/@InjectQueue\(\s*([^)]+)\)/g)) add(wiring.producers, queueName(match[1], file, source), file);
  }
  return wiring;
}

describe('BullMQ queue wiring (roadmap 4.6)', () => {
  const wiring = inventory();

  it('finds the application queues', () => {
    // 4.5/4.6 removed the dead consumer-only queues and 4.7 the sales relay pair.
    expect(wiring.registered.size).toBeGreaterThanOrEqual(8);
    for (const name of ['system-events', 'purchase-events', 'webhook-delivery', 'import-job', 'search-indexing']) {
      expect([...wiring.registered.keys()]).toContain(name);
    }
  });

  it('every registered queue has a consumer', () => {
    const orphans = [...wiring.registered.keys()].filter((name) => !wiring.consumers.has(name));
    expect(orphans).toEqual([]);
  });

  it('every registered queue has a producer (or a documented reason not to)', () => {
    const unfed = [...wiring.registered.keys()].filter((name) => !wiring.producers.has(name) && !(name in PRODUCER_ALLOWLIST));
    expect(unfed).toEqual([]);
  });

  it('every consumer and producer names a registered queue', () => {
    const unknown = [...new Set([...wiring.consumers.keys(), ...wiring.producers.keys()])].filter((name) => !wiring.registered.has(name));
    expect(unknown).toEqual([]);
  });

  it('the former dead queues are not registered anywhere reachable', () => {
    for (const name of ['internal-events', 'inventory-events', 'customer-queue', 'grn-jobs', 'purchase-returns', 'supplier-credits', 'vendor-bills', 'purchase-attachments', 'workflow-engine', 'barcode-bulk', 'invoice-pdf-queue', 'payment-reconciliation-queue', 'pricing-scheduler-queue', 'return-inspection-queue', 'return-refund-queue', 'sales-order-bulk-queue', 'sales-workflow-queue', 'sales-events', 'sales-webhooks']) {
      expect(wiring.registered.has(name)).toBe(false);
      expect(wiring.consumers.has(name)).toBe(false);
      expect(wiring.producers.has(name)).toBe(false);
    }
  });
});

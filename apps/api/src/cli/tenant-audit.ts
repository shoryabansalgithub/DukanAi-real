/**
 * Checks that no row of one shop points at a row of another (cross-shop
 * isolation audit, 2026-10-12), an operator command that ships in the API
 * image (roadmap 9.22, `run-cli.ts`):
 *
 *     node dist/cli/tenant-audit            # in the API container
 *     node dist/cli/tenant-audit --json     # the result as JSON
 *     npm run tenant-audit -- <the same arguments>   # from a checkout
 *
 * Read-only. Every to-one relation between two models that belong to a shop
 * is checked (`src/prisma/cross-shop-audit.ts`): a row of shop A naming shop
 * B's customer, product, user or document is what a missed ownership check
 * would leave behind. Exit 0 when every relation is clean, 1 when one is not
 * (the rows are listed), 2 on a usage or connection error. `DATABASE_URL`
 * comes from the environment.
 */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { auditCrossShopReferences, CrossShopAuditResult } from '../prisma/cross-shop-audit';
import { CliCommand, CliUsageError, runAsMain } from './run-cli';

export const TENANT_AUDIT_USAGE = 'usage: tenant-audit [--json]   (exit 0 clean, 1 a row of one shop names a row of another)';

export interface TenantAuditDeps {
  /** A client on `DATABASE_URL`, disconnected when the command ends. */
  connect: () => PrismaClient;
  audit: (db: PrismaClient) => Promise<CrossShopAuditResult>;
  out: (line: string) => void;
}

const DEFAULT_DEPS: TenantAuditDeps = {
  connect: () => {
    if (!process.env.DATABASE_URL) throw new CliUsageError('DATABASE_URL is not set');
    return new PrismaClient();
  },
  audit: (db) => auditCrossShopReferences(db),
  out: (line) => console.log(line),
};

const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v));

export function tenantAuditCommand(overrides: Partial<TenantAuditDeps> = {}): CliCommand {
  const deps: TenantAuditDeps = { ...DEFAULT_DEPS, ...overrides };
  return async (argv) => {
    const { values } = parseArgs({
      args: argv,
      options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
      strict: true,
    });
    if (values.help) {
      deps.out(TENANT_AUDIT_USAGE);
      return 0;
    }
    const db = deps.connect();
    try {
      const result = await deps.audit(db);
      if (values.json) {
        deps.out(json(result));
      } else {
        deps.out(`Relations checked: ${result.checked}`);
        if (result.findings.length === 0) {
          deps.out('CLEAN: no row of one shop names a row of another.');
        } else {
          for (const f of result.findings) deps.out(`CROSS-SHOP ${f.model}.${f.field} -> ${f.target}: ${f.rows} row(s), e.g. ${json(f.sample)}`);
        }
      }
      return result.findings.length === 0 ? 0 : 1;
    } finally {
      await db.$disconnect();
    }
  };
}

if (require.main === module) runAsMain(tenantAuditCommand());

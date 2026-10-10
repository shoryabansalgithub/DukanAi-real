/**
 * Financial reconciliation on demand (roadmap 9.5), an operator command that
 * ships in the API image (roadmap 9.22, `run-cli.ts`):
 *
 *     node dist/cli/reconcile --shop <shopId> [--date YYYY-MM-DD] [--json]   # in the API container
 *     node dist/cli/reconcile --all-shops [--date YYYY-MM-DD] [--json]
 *     npm run reconcile -- <the same arguments>                               # from a checkout
 *
 * Runs the engine of the nightly run and `POST /reconciliation/run`
 * (`src/reconciliation/reconciliation-engine.ts`) for one business day of
 * one shop (today so far in the shop's timezone when `--date` is omitted),
 * or of every shop the nightly sweep visits (`--all-shops`: each shop's
 * previous business day, the nightly run's own day, unless `--date` names
 * one). That is the catch-up after a missed night: a cron run never catches
 * up. Each run is recorded as a `ReconciliationRun` row with trigger CLI
 * (a recorded run also ends DukaanAiReconciliationStale); every check is
 * printed with its figures and drifts. Exit 0 when the books agree, 1 when
 * a check found drift, 2 on a usage or connection error or a run that
 * failed (recorded FAILED with the error). `--json` prints the run (an
 * array of runs with `--all-shops`). The engine only reads; the one row it
 * writes per shop is the run record. Nothing is corrected.
 *
 * `DATABASE_URL` comes from the environment: the container's own, or the
 * checkout's `.env.local` / `.env` through `scripts/reconcile.ts`.
 */
import { parseArgs } from 'node:util';
import { Prisma, PrismaClient, ReconciliationRun, ReconciliationRunStatus, ReconciliationTrigger } from '@prisma/client';
import { SWEPT_SHOP_STATUSES } from '../common/sweeps/per-shop-sweep';
import { businessDateString, parseBusinessDate, safeTimeZone } from '../common/time/business-day';
import { previousBusinessDate, reconcileBusinessDay, ReconciliationReport } from '../reconciliation/reconciliation-engine';
import { CliCommand, CliUsageError, runAsMain } from './run-cli';

export const RECONCILE_USAGE = [
  'usage: reconcile --shop <shopId> [--date YYYY-MM-DD] [--json]   (default day: today so far, in the shop\'s timezone)',
  '       reconcile --all-shops [--date YYYY-MM-DD] [--json]       (default day: each shop\'s previous business day, as the nightly run)',
].join('\n');

export interface ReconcileArgs {
  shopId?: string;
  allShops: boolean;
  date?: string;
  json: boolean;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      shop: { type: 'string' },
      'all-shops': { type: 'boolean', default: false },
      date: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const allShops = values['all-shops'] === true;
  if (!values.shop === !allShops) throw new CliUsageError(`name one shop (--shop <shopId>) or every shop (--all-shops)\n${RECONCILE_USAGE}`);
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new CliUsageError('--date must be YYYY-MM-DD');
  return { shopId: values.shop, allShops, date: values.date, json: values.json === true };
}

/** What the command reaches outside itself; the spec replaces each. */
export interface ReconcileDeps {
  /** A client on `DATABASE_URL`, disconnected when the command ends. */
  connect: () => PrismaClient;
  engine: typeof reconcileBusinessDay;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

const DEFAULT_DEPS: ReconcileDeps = {
  connect: () => {
    if (!process.env.DATABASE_URL) throw new CliUsageError('DATABASE_URL is not set');
    return new PrismaClient();
  },
  engine: reconcileBusinessDay,
  now: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const SHOP_SELECT = { id: true, name: true, settings: { select: { timezone: true } } } as const;
type ShopRow = { id: string; name: string; settings: { timezone: string | null } | null };

type Outcome =
  | { kind: 'run'; shop: ShopRow; report: ReconciliationReport; run: ReconciliationRun }
  | { kind: 'failed'; shop: ShopRow; error: string; run: ReconciliationRun }
  | { kind: 'skipped'; shop: ShopRow; businessDate: string; reason: string };

function printReport(out: (line: string) => void, report: ReconciliationReport, runId: string): void {
  const s = report.summary;
  out(`Reconciliation of ${report.businessDate} (${report.timeZone}), run ${runId}: ${report.status} (${report.driftCount} drift(s))`);
  out(
    `  ${s.sales.count} sale(s) ${s.sales.total}, ${s.returns.count} return(s) ${s.returns.total}, ${s.cancellations.count} cancellation(s) ${s.cancellations.total}, ${s.repayments.count} repayment(s) ${s.repayments.total}; net sales ${s.netSales}`,
  );
  out(`  tenders: cash ${s.tenders.CASH}, bank ${s.tenders.BANK}, credit ${s.tenders.UDHAR}; ${s.shiftsChecked} shift(s), ${s.itemsChecked} stock item(s), ${s.productsChecked} product(s)`);
  for (const check of report.checks) {
    const figures = Object.entries(check.figures)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    out(`  ${check.status.padEnd(12)} ${check.name.padEnd(10)} ${figures}`);
    for (const note of check.notes) out(`               note: ${note}`);
    for (const d of check.drifts) {
      out(`               DRIFT ${d.subject}: ${d.detail}: expected ${d.expected}, actual ${d.actual}${d.difference ? ` (difference ${d.difference})` : ''}`);
    }
  }
}

/** Reconciles one shop's day and records the run; an engine failure is recorded FAILED and returned, not thrown. */
async function reconcileShop(db: PrismaClient, deps: ReconcileDeps, shop: ShopRow, timeZone: string, businessDate: string, now: Date): Promise<Outcome> {
  let report: ReconciliationReport;
  try {
    report = await deps.engine(db, { shopId: shop.id, timeZone, businessDate, now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = await db.reconciliationRun.create({
      data: { shopId: shop.id, businessDate, timeZone, trigger: ReconciliationTrigger.CLI, status: ReconciliationRunStatus.FAILED, checks: [], error: message.slice(0, 4000), startedAt: now, finishedAt: deps.now() },
    });
    return { kind: 'failed', shop, error: message, run };
  }
  const run = await db.reconciliationRun.create({
    data: {
      shopId: shop.id,
      businessDate,
      timeZone,
      trigger: ReconciliationTrigger.CLI,
      status: report.status === 'DRIFT' ? ReconciliationRunStatus.DRIFT : ReconciliationRunStatus.CLEAN,
      driftCount: report.driftCount,
      checks: report.checks as unknown as Prisma.InputJsonValue,
      summary: report.summary as unknown as Prisma.InputJsonValue,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    },
  });
  return { kind: 'run', shop, report, run };
}

const asJson = (o: Outcome) =>
  o.kind === 'skipped' ? { shop: { id: o.shop.id, name: o.shop.name }, businessDate: o.businessDate, status: 'SKIPPED', reason: o.reason } : { ...o.run, shop: { id: o.shop.id, name: o.shop.name } };

export function reconcileCommand(overrides: Partial<ReconcileDeps> = {}): CliCommand {
  const deps: ReconcileDeps = { ...DEFAULT_DEPS, ...overrides };
  return async (argv) => {
    const args = parseReconcileArgs(argv);
    if (args === 'help') {
      deps.out(RECONCILE_USAGE);
      return 0;
    }
    const db = deps.connect();
    try {
      const now = deps.now();
      let shops: ShopRow[];
      if (args.allShops) {
        shops = await db.shop.findMany({ where: { status: { in: SWEPT_SHOP_STATUSES } }, select: SHOP_SELECT, orderBy: { id: 'asc' } });
      } else {
        const shop = await db.shop.findUnique({ where: { id: args.shopId }, select: SHOP_SELECT });
        if (!shop) throw new CliUsageError(`shop ${args.shopId} does not exist`);
        shops = [shop];
      }

      const outcomes: Outcome[] = [];
      for (const shop of shops) {
        const timeZone = safeTimeZone(shop.settings?.timezone);
        const businessDate = args.date ?? (args.allShops ? previousBusinessDate(now, timeZone) : businessDateString(now, timeZone));
        const start = parseBusinessDate(businessDate, timeZone);
        if (!start) throw new CliUsageError(`${businessDate} is not a calendar day`);
        if (start > now) {
          if (!args.allShops) throw new CliUsageError(`${businessDate} has not started in ${timeZone}`);
          outcomes.push({ kind: 'skipped', shop, businessDate, reason: `${businessDate} has not started in ${timeZone}` });
          continue;
        }
        outcomes.push(await reconcileShop(db, deps, shop, timeZone, businessDate, now));
      }

      if (!args.allShops) {
        const [outcome] = outcomes;
        if (outcome.kind === 'failed') throw new Error(`reconciliation failed: ${outcome.error} (recorded as run ${outcome.run.id})`);
        if (outcome.kind !== 'run') throw new Error('unreachable: a single shop is never skipped');
        if (args.json) deps.out(JSON.stringify(asJson(outcome), null, 2));
        else {
          deps.out(`Shop ${outcome.shop.id} (${outcome.shop.name})`);
          printReport(deps.out, outcome.report, outcome.run.id);
        }
        return outcome.report.status === 'DRIFT' ? 1 : 0;
      }

      const count = (kind: Outcome['kind'], status?: 'CLEAN' | 'DRIFT') => outcomes.filter((o) => o.kind === kind && (!status || (o.kind === 'run' && o.report.status === status))).length;
      if (args.json) deps.out(JSON.stringify(outcomes.map(asJson), null, 2));
      else {
        for (const o of outcomes) {
          const head = `Shop ${o.shop.id} (${o.shop.name})`;
          if (o.kind === 'skipped') deps.out(`${head}: skipped, ${o.reason}`);
          else if (o.kind === 'failed') deps.err(`${head}: FAILED ${o.run.businessDate}: ${o.error}; run ${o.run.id}`);
          else if (o.report.status === 'CLEAN') deps.out(`${head}: CLEAN ${o.report.businessDate} (${o.report.summary.sales.count} sale(s)); run ${o.run.id}`);
          else {
            deps.out(head);
            printReport(deps.out, o.report, o.run.id);
          }
        }
        deps.out(
          `Reconciliation of ${outcomes.length} shop(s)${args.date ? ` for ${args.date}` : ', each on its previous business day'}: ${count('run', 'CLEAN')} clean, ${count('run', 'DRIFT')} with drift, ${count('failed')} failed, ${count('skipped')} skipped`,
        );
      }
      if (count('failed') > 0) return 2;
      return count('run', 'DRIFT') > 0 ? 1 : 0;
    } finally {
      await db.$disconnect();
    }
  };
}

if (require.main === module) runAsMain(reconcileCommand());

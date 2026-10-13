/**
 * Legacy storage layout migration (roadmap 8.4).
 *
 * Moves customer folders from the pre-tenant layout
 *
 *     <STORAGE_ROOT>/Customers/<customerName>/...
 *
 * into the shop-scoped layout `StoragePathBuilder` uses today
 *
 *     <STORAGE_ROOT>/<shopId>/Customers/<customerId>/...
 *
 * The old layout carried no shop, so a folder name (the customer's name as
 * `sanitizeCustomerName` wrote it: "Ramesh Kumar" became "Ramesh_Kumar") is
 * the only key. The script therefore runs for ONE shop at a time (`--shop`),
 * matches a folder to the live customer of that shop whose sanitised name is
 * the folder name (`src/storage/legacy-folder-match.ts`), and refuses an
 * ambiguous folder (two customers of the shop map to it, or a customer of
 * ANOTHER shop does: the folder may hold that shop's documents) or an unknown
 * one instead of guessing: the operator resolves those by hand. Nothing moves unless `--yes` is given;
 * the default run reports what would happen. Existing destinations are never
 * overwritten. The old global `System` folder (customer_index.json and friends)
 * is left in place and reported; remove it once every shop has been migrated.
 *
 *     npm run storage:migrate-legacy -- --shop <shopId>          # dry run
 *     npm run storage:migrate-legacy -- --shop <shopId> --yes    # apply
 *
 * Environment: `DATABASE_URL` (read from `.env.local` / `.env` in apps/api
 * when not already set, as the API does) and `STORAGE_ROOT` (resolved against
 * the working directory, like `StoragePathBuilder`; `--root` overrides it). An
 * applied run writes a manifest of the moves to
 * `<root>/<shopId>/System/legacy-migration-<stamp>.json`. The exit code is 1
 * when any folder could not be migrated, in either mode.
 */
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import * as fs from 'fs-extra';
import { PrismaClient } from '@prisma/client';
import { LegacyCandidate, legacyNamePattern, matchLegacyFolder } from '../src/storage/legacy-folder-match';

interface Move {
  customerName: string;
  customerId: string;
  from: string;
  to: string;
}

interface Unresolved {
  folder: string;
  reason: string;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parse(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      shop: { type: 'string' },
      root: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('usage: migrate-storage --shop <shopId> [--root <dir>] [--yes]');
    process.exit(0);
  }
  if (!values.shop) fail('--shop <shopId> is required: the legacy layout names no shop, so one run migrates one shop');
  return { shopId: values.shop, root: values.root, apply: values.yes === true };
}

async function main(): Promise<number> {
  dotenv.config({ path: '.env.local' });
  dotenv.config();
  const { shopId, root: rootOverride, apply } = parse(process.argv.slice(2));
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');

  const root = path.resolve(rootOverride ?? process.env.STORAGE_ROOT ?? path.join('data', 'storage'));
  const legacyCustomers = path.join(root, 'Customers');
  const legacySystem = path.join(root, 'System');

  const prisma = new PrismaClient();
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true } });
    if (!shop) fail(`shop ${shopId} does not exist`);
    console.log(`${apply ? 'Migrating' : 'Dry run for'} shop ${shop.id} (${shop.name}); storage root ${root}`);

    if (!(await fs.pathExists(legacyCustomers))) {
      console.log(`No legacy folder at ${legacyCustomers}: nothing to migrate.`);
      return 0;
    }

    const moves: Move[] = [];
    const unresolved: Unresolved[] = [];
    const entries = (await fs.readdir(legacyCustomers, { withFileTypes: true })).filter((e) => e.isDirectory());

    for (const entry of entries) {
      const customerName = entry.name;
      const from = path.join(legacyCustomers, customerName);
      // Every live customer, of any shop, whose name could sanitise to the
      // folder name (a LIKE superset; matchLegacyFolder compares exactly).
      // Other shops are read on purpose: a folder another shop's customer maps
      // to is not handed to this shop.
      const candidates = await prisma.$queryRaw<LegacyCandidate[]>`
        SELECT id, shopId, name FROM Customer WHERE isDeleted = 0 AND name LIKE ${legacyNamePattern(customerName)} ORDER BY id
      `;
      const match = matchLegacyFolder(customerName, shop.id, candidates);
      if (match.kind === 'none') {
        unresolved.push({ folder: customerName, reason: 'no live customer of this shop has a name that maps to this folder' });
        continue;
      }
      if (match.kind === 'ambiguous') {
        unresolved.push({ folder: customerName, reason: match.reason });
        continue;
      }
      const to = path.join(root, shop.id, 'Customers', match.customerId);
      if (await fs.pathExists(to)) {
        unresolved.push({ folder: customerName, reason: `destination ${path.relative(root, to)} already exists; never overwritten` });
        continue;
      }
      moves.push({ customerName, customerId: match.customerId, from, to });
    }

    for (const move of moves) {
      console.log(`${apply ? 'MOVE' : 'would move'}  ${path.relative(root, move.from)}  ->  ${path.relative(root, move.to)}`);
      if (apply) {
        await fs.ensureDir(path.dirname(move.to));
        await fs.move(move.from, move.to, { overwrite: false });
      }
    }
    for (const item of unresolved) {
      console.warn(`SKIP  ${path.join('Customers', item.folder)}: ${item.reason}`);
    }

    if (apply && moves.length > 0) {
      const manifestDir = path.join(root, shop.id, 'System');
      await fs.ensureDir(manifestDir);
      const manifest = path.join(manifestDir, `legacy-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.writeJson(
        manifest,
        {
          shopId: shop.id,
          root,
          movedAt: new Date().toISOString(),
          moves: moves.map((m) => ({ ...m, from: path.relative(root, m.from), to: path.relative(root, m.to) })),
          unresolved,
        },
        { spaces: 2 },
      );
      console.log(`Manifest written to ${path.relative(root, manifest)}`);
    }

    if (await fs.pathExists(legacySystem)) {
      console.log(`Legacy global folder ${path.relative(root, legacySystem)} left in place; remove it once every shop is migrated.`);
    }

    console.log(`${apply ? 'Moved' : 'Would move'} ${moves.length} folder(s); ${unresolved.length} left for the operator.`);
    return unresolved.length > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exit(2);
  },
);

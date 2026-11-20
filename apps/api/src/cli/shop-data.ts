/**
 * A shop's data requests (roadmap 9.24; the procedure, notice periods and
 * what to tell the shop are docs/privacy/DATA_REQUESTS.md), an operator
 * command that ships in the API image (roadmap 9.22, `run-cli.ts`):
 *
 *     node dist/cli/shop-data export --shop <id> --out <dir> [--no-archive]
 *     node dist/cli/shop-data suspend --shop <id> [--yes]
 *     node dist/cli/shop-data erase --shop <id> --export <archive> [--yes]
 *     node dist/cli/shop-data erase-customer --shop <id> --customer <id> [--yes]
 *     npm run shop-data -- <the same arguments>                       # from a checkout
 *
 * `export` writes `dukaanai-export-<shop>-<stamp>.tar.gz` (+ `.sha256`): every
 * row of the shop as JSON lines, the books as CSV, its documents, photos and
 * import files, a manifest and SHA-256 sums; credentials are never written.
 * `suspend` stops the shop and signs everyone out (reversible). `erase`
 * rewrites every personal column of the shop by its class
 * (`src/privacy/personal-data.ts`), closes the accounts and removes the files;
 * it refuses an ACTIVE shop and needs the export archive of the same shop.
 * `erase-customer` forgets one customer of the shop (refused while a balance
 * is open; a GST legal hold keeps name and address). Without `--yes` every
 * mutating command is a dry run that prints what it would do. `--json`
 * prints the result as JSON (the receipt for the support ticket). Exit 0 on
 * success, 2 on a refusal or a usage / connection error.
 *
 * Paths: `STORAGE_ROOT` (documents) and the API's `uploads` directory come
 * from the environment and the working directory (`/app/apps/api` in the
 * image), as the API reads them; `--storage-root` / `--uploads` override.
 */
import { createReadStream, readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { eraseCustomer, eraseShop, ErasureReceipt, exportShop, ShopDataError, ShopDataPaths, suspendShop } from '../privacy/shop-data';
import { CliCommand, CliUsageError, runAsMain } from './run-cli';

export const SHOP_DATA_USAGE = [
  'usage: shop-data export --shop <id> --out <dir> [--no-archive] [--json]',
  '       shop-data suspend --shop <id> [--yes] [--json]',
  '       shop-data erase --shop <id> --export <dukaanai-export-...tar.gz> [--yes] [--json]',
  '       shop-data erase-customer --shop <id> --customer <id> [--yes] [--json]',
  '       (mutating commands are dry runs without --yes; --storage-root, --uploads override the paths)',
].join('\n');

export interface ShopDataDeps {
  connect: () => PrismaClient;
  now: () => Date;
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
}

const DEFAULT_DEPS: ShopDataDeps = {
  connect: () => {
    if (!process.env.DATABASE_URL) throw new CliUsageError('DATABASE_URL is not set');
    return new PrismaClient();
  },
  now: () => new Date(),
  out: (line) => console.log(line),
  env: process.env,
  cwd: () => process.cwd(),
};

/**
 * The export a shop erasure names must be of the same shop and intact
 * (audit F8): the archive's SHA-256 must equal its `.sha256` sidecar (a
 * truncated or swapped archive is refused), and the manifest inside it must
 * name this shop and the export format. The file name alone proved nothing.
 */
export async function checkExportArchive(archive: string, shopId: string): Promise<void> {
  const base = path.basename(archive);
  if (!base.startsWith(`dukaanai-export-${shopId}-`) || !base.endsWith('.tar.gz')) {
    throw new CliUsageError(`--export must be this shop's export archive (dukaanai-export-${shopId}-<stamp>.tar.gz), got ${base}`);
  }
  if (!existsSync(archive)) throw new CliUsageError(`--export ${archive} does not exist`);
  if (!existsSync(`${archive}.sha256`)) throw new CliUsageError(`--export ${archive} has no .sha256 sidecar`);
  const recorded = readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(recorded)) throw new CliUsageError(`${archive}.sha256 is not a SHA-256 sidecar`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
  const actual = hash.digest('hex');
  if (actual !== recorded) throw new CliUsageError(`--export ${archive} does not match its .sha256 sidecar (archive ${actual}, sidecar ${recorded}): the export is damaged; take a new one`);
  const directory = base.slice(0, -'.tar.gz'.length);
  const tar = spawnSync('tar', ['-xzOf', archive, `${directory}/manifest.json`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  type Manifest = { format?: unknown; shop?: { id?: unknown } };
  let manifest: Manifest | null;
  try {
    manifest = tar.status === 0 ? (JSON.parse(tar.stdout) as Manifest) : null;
  } catch {
    manifest = null;
  }
  if (!manifest) throw new CliUsageError(`--export ${archive} holds no readable ${directory}/manifest.json`);
  if (manifest.format !== 'dukaanai-shop-export/1' || manifest.shop?.id !== shopId) {
    throw new CliUsageError(`--export ${archive} is not an export of shop ${shopId} (its manifest names ${String(manifest.shop?.id)})`);
  }
}

function printReceipt(out: (line: string) => void, receipt: ErasureReceipt): void {
  const verb = receipt.dryRun ? 'Would rewrite' : 'Rewrote';
  out(`${receipt.dryRun ? 'Dry run: nothing changed.' : 'Done.'} ${receipt.kind === 'shop' ? `Shop ${receipt.shopId}` : `Customer ${receipt.customerId} of shop ${receipt.shopId}`}`);
  for (const [model, n] of Object.entries(receipt.rows).sort()) out(`  ${verb} ${n} row(s) of ${model}`);
  for (const [model, n] of Object.entries(receipt.deleted).sort()) out(`  Deleted ${n} row(s) of ${model}`);
  out(`  Files ${receipt.dryRun ? 'to remove' : 'removed'}: ${receipt.files.removed}${receipt.files.kept.length ? `; kept ${receipt.files.kept.join(', ')}` : ''}`);
  if (receipt.legalHold.length) out(`  GST legal hold (name and address kept): ${receipt.legalHold.join('; ')}`);
  if (receipt.dryRun) out('Pass --yes to execute.');
}

export function shopDataCommand(overrides: Partial<ShopDataDeps> = {}): CliCommand {
  const deps: ShopDataDeps = { ...DEFAULT_DEPS, ...overrides };
  return async (argv) => {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        shop: { type: 'string' },
        customer: { type: 'string' },
        out: { type: 'string' },
        export: { type: 'string' },
        'storage-root': { type: 'string' },
        uploads: { type: 'string' },
        'no-archive': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (values.help) {
      deps.out(SHOP_DATA_USAGE);
      return 0;
    }
    const [action] = positionals;
    if (!['export', 'suspend', 'erase', 'erase-customer'].includes(action ?? '') || positionals.length !== 1) throw new CliUsageError(SHOP_DATA_USAGE);
    if (!values.shop) throw new CliUsageError(`--shop <id> is required\n${SHOP_DATA_USAGE}`);
    if (action === 'export' && !values.out) throw new CliUsageError('--out <dir> is required for export');
    if (action === 'erase' && !values.export) throw new CliUsageError('--export <archive> is required: a shop is erased only after its export was taken (docs/privacy/DATA_REQUESTS.md)');
    if (action === 'erase-customer' && !values.customer) throw new CliUsageError('--customer <id> is required');
    if (action === 'erase') await checkExportArchive(path.resolve(values.export!), values.shop);

    const cwd = deps.cwd();
    const paths: ShopDataPaths = {
      storageRoot: path.resolve(cwd, values['storage-root'] ?? deps.env.STORAGE_ROOT ?? './data/storage'),
      uploadsRoot: path.resolve(cwd, values.uploads ?? 'uploads'),
      workingDirectory: cwd,
    };
    const emit = (value: unknown, text: () => void) => (values.json ? deps.out(JSON.stringify(value, null, 2)) : text());

    const db = deps.connect();
    try {
      const now = deps.now();
      if (action === 'export') {
        const result = await exportShop(db, { ...paths, shopId: values.shop, outDir: path.resolve(cwd, values.out!), now, release: deps.env.APP_RELEASE, archive: !values['no-archive'] });
        emit(result, () => {
          const rows = Object.values(result.tables).reduce((a, b) => a + b, 0);
          deps.out(`Exported shop ${result.shopId}: ${rows} row(s) in ${Object.values(result.tables).filter((n) => n > 0).length} table(s), ${result.files.documents} document(s), ${result.files.media} photo(s), ${result.files.imports} import file(s)`);
          if (result.files.missingMedia.length) deps.out(`  Missing on disk (listed in the manifest): ${result.files.missingMedia.length} media file(s)`);
          deps.out(`  ${result.archive ?? result.directory}${result.archiveSha256 ? `\n  sha256 ${result.archiveSha256}` : ''}`);
        });
        return 0;
      }
      if (action === 'suspend') {
        if (!values.yes) {
          deps.out(`Dry run: shop ${values.shop} would be SUSPENDED (every request refused) and every session of its people ended. Nothing is erased. Pass --yes.`);
          return 0;
        }
        const result = await suspendShop(db, values.shop, now);
        emit(result, () => deps.out(`Shop ${result.shopId}: ${result.previousStatus} -> SUSPENDED; ${result.usersSignedOut} user(s) signed out, ${result.refreshTokensRevoked} refresh token(s) revoked.`));
        return 0;
      }
      const receipt =
        action === 'erase'
          ? await eraseShop(db, { ...paths, shopId: values.shop, now, dryRun: !values.yes })
          : await eraseCustomer(db, { storageRoot: paths.storageRoot, uploadsRoot: paths.uploadsRoot, shopId: values.shop, customerId: values.customer!, now, dryRun: !values.yes });
      emit(receipt, () => printReceipt(deps.out, receipt));
      return 0;
    } catch (error) {
      if (error instanceof ShopDataError) throw new CliUsageError(error.message);
      throw error;
    } finally {
      await db.$disconnect();
    }
  };
}

if (require.main === module) runAsMain(shopDataCommand());

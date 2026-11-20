import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { promises as fs, createReadStream, existsSync } from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { csvCell } from '../import-export/import-columns';
import { ChildModel, childModels, ClassifiedField, erasableFields, GST_NAMED_RECIPIENT_THRESHOLD, gstRetentionEnds, inventory, TenantModel, tenantModels } from './personal-data';
import { normalizePhone } from '../import-export/import-rows';

/**
 * A shop's data export and its deletion request (roadmap 9.24; procedure in
 * docs/privacy/DATA_REQUESTS.md, operator command `node dist/cli/shop-data`).
 *
 *  - export: every row of every model that belongs to the shop (JSON lines,
 *    credentials left out), readable CSV for the books, the shop's stored
 *    documents, product photos and import files, a manifest and SHA-256 sums.
 *  - suspend: the shop stops (TenantGuard refuses a non-ACTIVE shop) and
 *    every session of its people ends; nothing is erased. The notice period
 *    of a deletion request runs from here.
 *  - erase: every personal column of every row of the shop is rewritten by
 *    its class (`personal-data.ts`), the people's accounts are closed and
 *    anonymised, sessions, invitations, notifications and search history are
 *    deleted, and the files are removed. What remains is non-personal
 *    financial history: the ledger is immutable by design (no personal text
 *    in it since migration 20261011090000) and documents point at the
 *    anonymised rows.
 *  - erase-customer: one of the shop's customers asks the shop to be
 *    forgotten. Refused while the customer owes or is owed money; a legal
 *    hold keeps the name and address the GST rules require on an invoice
 *    still in its retention period.
 *
 * Everything runs as raw SQL on a plain PrismaClient (no tenant extension):
 * every statement names the shop.
 */
export class ShopDataError extends Error {}

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

const q = (identifier: string) => `\`${identifier.replace(/`/g, '``')}\``;
const PAGE = 1000;
const ERASED = '[erased]';
/** The Shop row itself: it has no shopId column, its key is the shop id. */
const SHOP_MODEL: TenantModel = { name: 'Shop', table: 'Shop', idColumns: ['id'], shopColumn: 'id' };

function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString();
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

async function loadShop(db: Db | Tx, shopId: string) {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string; status: string; ownerId: string | null }>>(
    'SELECT `id`, `name`, `status`, `ownerId` FROM `Shop` WHERE `id` = ?',
    shopId,
  );
  if (rows.length === 0) throw new ShopDataError(`shop ${shopId} does not exist`);
  return rows[0];
}

/** The newest migration applied to the database the export was taken from. */
async function schemaVersion(db: Db): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT `migration_name` FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL ORDER BY `migration_name` DESC LIMIT 1',
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

/** Every row of one model that belongs to the shop, a page at a time, secrets dropped. */
async function* shopRows(db: Db, model: TenantModel, shopId: string, secrets: Set<string>): AsyncGenerator<Record<string, unknown>> {
  const order = model.idColumns.map(q).join(', ');
  const single = model.idColumns.length === 1 ? model.idColumns[0] : null;
  let after: unknown = null;
  let offset = 0;
  for (;;) {
    const rows = single
      ? await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM ${q(model.table)} WHERE ${q(model.shopColumn)} = ?${after === null ? '' : ` AND ${q(single)} > ?`} ORDER BY ${order} LIMIT ${PAGE}`,
          ...(after === null ? [shopId] : [shopId, after]),
        )
      : await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT * FROM ${q(model.table)} WHERE ${q(model.shopColumn)} = ? ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`,
          shopId,
        );
    for (const row of rows) {
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) if (!secrets.has(key)) clean[key] = serialise(value);
      yield clean;
    }
    if (rows.length < PAGE) return;
    if (single) after = rows[rows.length - 1][single];
    else offset += PAGE;
  }
}

/**
 * The FROM clause and shop predicate of a child table (audit F2): the child
 * is `t0`, each hop joins the next parent as `t1`, `t2` ..., and the last row
 * on the way names the shop (two columns for a stock transfer: either shop).
 */
function childScope(child: ChildModel): { from: string; where: string; shopParams: number } {
  const joins = child.hops.map((hop, i) => {
    const on = hop.parentColumns.map((col, k) => `t${i + 1}.${q(col)} = t${i}.${q(hop.childColumns[k])}`).join(' AND ');
    return `JOIN ${q(hop.table)} t${i + 1} ON ${on}`;
  });
  const last = `t${child.hops.length}`;
  const where = child.shopColumns.length === 1 ? `${last}.${q(child.shopColumns[0])} = ?` : `(${child.shopColumns.map((col) => `${last}.${q(col)} = ?`).join(' OR ')})`;
  return { from: [`${q(child.table)} t0`, ...joins].join(' '), where, shopParams: child.shopColumns.length };
}

/** Every row of a child table that belongs to the shop through its parents, a page at a time, secrets dropped. */
async function* childRows(db: Db, child: ChildModel, shopId: string, secrets: Set<string>): AsyncGenerator<Record<string, unknown>> {
  const scope = childScope(child);
  const shopParams = Array<string>(scope.shopParams).fill(shopId);
  let after: unknown = null;
  for (;;) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT t0.* FROM ${scope.from} WHERE ${scope.where}${after === null ? '' : ` AND t0.${q(child.idColumn)} > ?`} ORDER BY t0.${q(child.idColumn)} LIMIT ${PAGE}`,
      ...(after === null ? shopParams : [...shopParams, after]),
    );
    for (const row of rows) {
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) if (!secrets.has(key)) clean[key] = serialise(value);
      yield clean;
    }
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1][child.idColumn];
  }
}

/** Readable copies for the shop's accountant: the GST-relevant tables as CSV. */
const CSV_TABLES: Record<string, string> = {
  Invoice: 'invoices',
  InvoiceItem: 'invoice-items',
  InvoicePayment: 'invoice-payments',
  Customer: 'customers',
  UdharTransaction: 'credit-transactions',
  Product: 'products',
  Expense: 'expenses',
  Supplier: 'suppliers',
};

async function writeCsv(file: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => typeof r[c] !== 'object' || r[c] === null));
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c] === null || row[c] === undefined ? '' : String(row[c]))).join(','));
  await fs.writeFile(file, `${lines.join('\r\n')}\r\n`, 'utf8');
}

/** Media file paths the shop's rows point at (stored relative to the API's working directory or absolute). */
async function mediaPaths(db: Db | Tx, shopId: string): Promise<string[]> {
  const out = new Set<string>();
  for (const table of ['MediaStorage', 'MediaThumbnail', 'MediaVersion']) {
    try {
      const rows = await db.$queryRawUnsafe<Array<{ path: string | null }>>(`SELECT \`path\` FROM ${q(table)} WHERE \`shopId\` = ?`, shopId);
      for (const r of rows) if (r.path && r.path !== ERASED) out.add(r.path);
    } catch {
      // a scaffolding table that is absent on this database: nothing of the shop is in it
    }
  }
  return [...out].sort();
}

/** Removes a file or directory; true when there was one to remove. */
async function removeIfPresent(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
  } catch {
    return false;
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

function resolveUnder(base: string, stored: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(base, stored);
}

async function importFiles(uploadsRoot: string, shopId: string): Promise<string[]> {
  const dir = path.join(uploadsRoot, 'imports');
  if (!existsSync(dir)) return [];
  return (await fs.readdir(dir)).filter((name) => name.startsWith(`${shopId}-`)).map((name) => path.join(dir, name)).sort();
}

export interface ShopDataPaths {
  /** STORAGE_ROOT: documents live under `<root>/<shopId>`. */
  storageRoot: string;
  /** The API's `uploads` directory (media and import files). */
  uploadsRoot: string;
  /** What relative media paths are relative to (the API's working directory). */
  workingDirectory: string;
}

export interface ExportOptions extends ShopDataPaths {
  shopId: string;
  outDir: string;
  now: Date;
  release?: string;
  /** Leave the directory instead of packing it into `<name>.tar.gz` (tests, inspection). */
  archive?: boolean;
}

export interface ExportResult {
  shopId: string;
  directory: string;
  archive: string | null;
  archiveSha256: string | null;
  tables: Record<string, number>;
  files: { documents: number; media: number; imports: number; missingMedia: string[] };
}

export async function exportShop(db: Db, options: ExportOptions): Promise<ExportResult> {
  const shop = await loadShop(db, options.shopId);
  const stamp = options.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `dukaanai-export-${shop.id}-${stamp}`;
  const dir = path.join(path.resolve(options.outDir), name);
  if (existsSync(dir) || existsSync(`${dir}.tar.gz`)) throw new ShopDataError(`${dir} already exists`);
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.mkdir(path.join(dir, 'csv'), { recursive: true });

  const secretsByModel = new Map<string, Set<string>>();
  for (const row of inventory()) {
    if (row.cls !== 'secret') continue;
    const set = secretsByModel.get(row.model) ?? new Set<string>();
    set.add(row.dbName);
    secretsByModel.set(row.model, set);
  }

  const tables: Record<string, number> = {};
  // Tenant tables by their shop column, then the child tables through their
  // parents (audit F2: the lines of every invoice, a customer's audit trail,
  // an import's report ... have no shop column and were left out).
  const sources: Array<{ name: string; rows: () => AsyncGenerator<Record<string, unknown>> }> = [
    ...[SHOP_MODEL, ...tenantModels()].map((model) => ({ name: model.name, rows: () => shopRows(db, model, shop.id, secretsByModel.get(model.name) ?? new Set()) })),
    ...childModels().map((child) => ({ name: child.name, rows: () => childRows(db, child, shop.id, secretsByModel.get(child.name) ?? new Set()) })),
  ];
  for (const model of sources) {
    let count = 0;
    let handle: import('fs/promises').FileHandle | null = null;
    const csvRows: Array<Record<string, unknown>> = [];
    try {
      for await (const row of model.rows()) {
        handle ??= await fs.open(path.join(dir, 'data', `${model.name}.jsonl`), 'wx');
        await handle.write(`${JSON.stringify(row)}\n`);
        if (CSV_TABLES[model.name]) csvRows.push(row);
        count++;
      }
    } catch (error) {
      // A detached scaffolding model whose table this database never got is not the shop's data.
      if ((error as { code?: string }).code !== 'P2010' || !/doesn't exist|1146/.test((error as Error).message)) throw error;
    } finally {
      await handle?.close();
    }
    tables[model.name] = count;
    if (CSV_TABLES[model.name] && csvRows.length > 0) await writeCsv(path.join(dir, 'csv', `${CSV_TABLES[model.name]}.csv`), csvRows);
  }

  // Files: the shop's documents tree, its product photos, its import uploads.
  const documentsSource = path.join(options.storageRoot, shop.id);
  let documents = 0;
  if (existsSync(documentsSource)) {
    await fs.cp(documentsSource, path.join(dir, 'documents'), { recursive: true });
    documents = (await walk(path.join(dir, 'documents'))).length;
  }
  const missingMedia: string[] = [];
  let media = 0;
  for (const stored of await mediaPaths(db, shop.id)) {
    const source = resolveUnder(options.workingDirectory, stored);
    if (!existsSync(source)) {
      missingMedia.push(stored);
      continue;
    }
    const target = path.join(dir, 'media', path.basename(source));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    media++;
  }
  const imports = await importFiles(options.uploadsRoot, shop.id);
  for (const file of imports) {
    await fs.mkdir(path.join(dir, 'imports'), { recursive: true });
    await fs.copyFile(file, path.join(dir, 'imports', path.basename(file)));
  }

  const manifest = {
    format: 'dukaanai-shop-export/1',
    shop: { id: shop.id, name: shop.name, status: shop.status },
    generatedAt: options.now.toISOString(),
    release: options.release ?? null,
    schemaMigration: await schemaVersion(db),
    tables,
    files: { documents, media, imports: imports.length, missingMedia },
    notes: [
      'data/<Model>.jsonl: one JSON object per row, every column of the shop\'s rows; credentials (password hashes, token hashes, webhook secrets) are left out.',
      'csv/: the books (invoices, lines, payments, customers, credit, products, expenses, suppliers) for a spreadsheet; formula-like cells are prefixed with an apostrophe.',
      'documents/: the files the shop stored (invoices, captured bills, statements); media/: product photos; imports/: files uploaded for onboarding imports.',
      'Amounts are decimal strings in rupees; times are UTC (ISO 8601). SHA256SUMS lists every file.',
    ],
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums: string[] = [];
  for (const file of await walk(dir)) sums.push(`${await sha256File(file)}  ${path.relative(dir, file).split(path.sep).join('/')}`);
  await fs.writeFile(path.join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  let archive: string | null = null;
  let archiveSha256: string | null = null;
  if (options.archive !== false) {
    archive = `${dir}.tar.gz`;
    const tar = spawnSync('tar', ['-czf', archive, '-C', path.dirname(dir), name], { encoding: 'utf8' });
    if (tar.status !== 0) throw new ShopDataError(`tar failed: ${tar.stderr || tar.error?.message}`);
    archiveSha256 = await sha256File(archive);
    await fs.writeFile(`${archive}.sha256`, `${archiveSha256}  ${path.basename(archive)}\n`);
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { shopId: shop.id, directory: dir, archive, archiveSha256, tables, files: { documents, media, imports: imports.length, missingMedia } };
}

// ---------------------------------------------------------------------------
// Suspension and erasure
// ---------------------------------------------------------------------------

export interface SuspendResult {
  shopId: string;
  previousStatus: string;
  usersSignedOut: number;
  refreshTokensRevoked: number;
}

/** Stops the shop (every request answers 403) and ends every session of its people. Reversible: nothing is erased. */
export async function suspendShop(db: Db, shopId: string, now: Date): Promise<SuspendResult> {
  return db.$transaction(async (tx) => {
    const shop = await loadShop(tx, shopId);
    await tx.$executeRawUnsafe('UPDATE `Shop` SET `status` = \'SUSPENDED\', `updatedAt` = ? WHERE `id` = ? AND `status` = \'ACTIVE\'', now, shopId);
    const tokens = await tx.$executeRawUnsafe(
      'UPDATE `RefreshToken` SET `isRevoked` = 1 WHERE `isRevoked` = 0 AND `userId` IN (SELECT `id` FROM `User` WHERE `shopId` = ?)',
      shopId,
    );
    const users = await tx.$executeRawUnsafe('UPDATE `User` SET `tokenVersion` = `tokenVersion` + 1 WHERE `shopId` = ?', shopId);
    return { shopId, previousStatus: shop.status, usersSignedOut: users, refreshTokensRevoked: tokens };
  });
}

/** The SQL value an erased column gets, by class, nullability and uniqueness (`qualified`: the id is already a column reference). */
function erasedValue(field: ClassifiedField, idColumn: string | null, qualified = false): string {
  if (!field.required) return 'NULL';
  if (field.type === 'Json') return "'{}'";
  if (field.unique && idColumn) return `CONCAT('erased-', ${qualified ? idColumn : q(idColumn)})`;
  return `'${ERASED}'`;
}

/** Overrides for columns whose erased value is not the generic one. */
const SPECIAL: Record<string, (id: string) => string> = {
  'User.email': (id) => `CONCAT('erased-', ${q(id)}, '@erased.invalid')`,
};

/** Extra assignments when a row is erased (soft delete, closed account). */
const ALSO: Record<string, (nowParam: string) => string[]> = {
  User: (now) => ['`isActive` = 0', '`isDeleted` = 1', `\`deletedAt\` = COALESCE(\`deletedAt\`, ${now})`, '`tokenVersion` = `tokenVersion` + 1', '`failedAttempts` = 0'],
  Customer: (now) => ['`isDeleted` = 1', `\`deletedAt\` = COALESCE(\`deletedAt\`, ${now})`, '`deletedToken` = `id`', '`isActive` = 0'],
  Shop: (now) => ["`status` = 'DELETED'", '`isDeleted` = 1', `\`deletedAt\` = COALESCE(\`deletedAt\`, ${now})`],
};

/** Tables never rewritten: immutable by design and free of personal text (personal-data.spec.ts proves the second). */
const NEVER_TOUCHED = new Set(['LedgerTransaction']);

interface ErasureStatement {
  model: string;
  sql: string;
  params: unknown[];
  fields: string[];
  /** `SELECT COUNT(*)` of the rows the statement rewrites (dry runs). */
  countSql: string;
  countParams: unknown[];
}


function erasureStatements(scope: { shopId: string; customerId?: string; keep?: Set<string> }, now: Date): ErasureStatement[] {
  const byModel = erasableFields();
  const out: ErasureStatement[] = [];
  const models = scope.customerId ? tenantModels() : [SHOP_MODEL, ...tenantModels()];
  for (const model of models) {
    if (NEVER_TOUCHED.has(model.name)) continue;
    const fields = (byModel.get(model.name) ?? []).filter((f) => !scope.keep?.has(`${f.model}.${f.field}`));
    if (fields.length === 0) continue;
    const modelMeta = Prisma.dmmf.datamodel.models.find((m) => m.name === model.name)!;
    let where = `${q(model.shopColumn)} = ?`;
    const params: unknown[] = [scope.shopId];
    if (scope.customerId) {
      // a customer's own row, and rows that name the customer
      if (model.name === 'Customer') {
        where += ' AND `id` = ?';
      } else if (modelMeta.fields.some((f) => f.name === 'customerId' && f.kind === 'scalar')) {
        where += ' AND `customerId` = ?';
      } else continue;
      params.push(scope.customerId);
    }
    const id = model.idColumns.length === 1 ? model.idColumns[0] : null;
    const sets = fields.map((f) => `${q(f.dbName)} = ${SPECIAL[`${f.model}.${f.field}`]?.(id ?? 'id') ?? erasedValue(f, id)}`);
    const extra = ALSO[model.name]?.('?') ?? [];
    const extraParams = extra.filter((s) => s.includes('?')).map(() => now);
    out.push({
      model: model.name,
      sql: `UPDATE ${q(model.table)} SET ${[...sets, ...extra].join(', ')} WHERE ${where}`,
      params: [...extraParams, ...params],
      fields: fields.map((f) => f.field),
      countSql: `SELECT COUNT(*) AS n FROM ${q(model.table)} WHERE ${where}`,
      countParams: params,
    });
  }
  return out;
}

/**
 * The erasure of the child tables (audit F3): the same rewrite by class,
 * through the joins that reach the shop (a multi-table UPDATE), so a
 * customer's audit trail, an import's raw rows, a photo's EXIF, a webhook's
 * logged payloads and a revision's review comments go with the rest. In a
 * customer's erasure only the children that name the customer (`customerId`)
 * are rewritten, and only that customer's rows.
 */
function childErasureStatements(scope: { shopId: string; customerId?: string; keep?: Set<string> }): ErasureStatement[] {
  const byModel = erasableFields();
  const out: ErasureStatement[] = [];
  for (const child of childModels()) {
    if (NEVER_TOUCHED.has(child.name)) continue;
    if (scope.customerId && !child.customerColumn) continue;
    const fields = (byModel.get(child.name) ?? []).filter((f) => !scope.keep?.has(`${f.model}.${f.field}`));
    if (fields.length === 0) continue;
    const { from, where: shopWhere, shopParams } = childScope(child);
    let where = shopWhere;
    const params: unknown[] = Array<string>(shopParams).fill(scope.shopId);
    if (scope.customerId) {
      where += ` AND t0.${q(child.customerColumn!)} = ?`;
      params.push(scope.customerId);
    }
    const sets = fields.map((f) => `t0.${q(f.dbName)} = ${erasedValue(f, `t0.${q(child.idColumn)}`, true)}`);
    out.push({
      model: child.name,
      sql: `UPDATE ${from} SET ${sets.join(', ')} WHERE ${where}`,
      params,
      fields: fields.map((f) => f.field),
      countSql: `SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`,
      countParams: params,
    });
  }
  return out;
}

async function countRows(db: Db, statements: ErasureStatement[]): Promise<Record<string, number>> {
  const rows: Record<string, number> = {};
  for (const s of statements) {
    const count = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(s.countSql, ...s.countParams);
    const n = Number(count[0]?.n ?? 0);
    if (n > 0) rows[s.model] = n;
  }
  return rows;
}

export interface ErasureReceipt {
  kind: 'shop' | 'customer';
  shopId: string;
  customerId?: string;
  executedAt: string;
  dryRun: boolean;
  rows: Record<string, number>;
  deleted: Record<string, number>;
  files: { removed: number; kept: string[] };
  legalHold: string[];
}

export interface EraseShopOptions extends ShopDataPaths {
  shopId: string;
  now: Date;
  dryRun: boolean;
}

/**
 * Erases the shop's personal data (see the file header). Refused while the
 * shop is ACTIVE: suspend first, deliver the export, wait out the notice
 * period (docs/privacy/DATA_REQUESTS.md).
 */
export async function eraseShop(db: Db, options: EraseShopOptions): Promise<ErasureReceipt> {
  const shop = await loadShop(db, options.shopId);
  if (shop.status === 'ACTIVE') throw new ShopDataError(`shop ${shop.id} is ACTIVE: suspend it first (shop-data suspend), deliver the export, then erase`);
  const statements = [...erasureStatements({ shopId: shop.id }, options.now), ...childErasureStatements({ shopId: shop.id })];
  const files = [
    ...(existsSync(path.join(options.storageRoot, shop.id)) ? [path.join(options.storageRoot, shop.id)] : []),
    ...(await importFiles(options.uploadsRoot, shop.id)),
  ];
  const media = await mediaPaths(db, shop.id);

  const rows: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  if (options.dryRun) {
    Object.assign(rows, await countRows(db, statements));
    return { kind: 'shop', shopId: shop.id, executedAt: options.now.toISOString(), dryRun: true, rows, deleted, files: { removed: files.length + media.length, kept: [] }, legalHold: [] };
  }

  // Media files shared with another shop (content-addressed paths) are kept.
  const shared = new Set<string>();
  for (const stored of media) {
    let others = 0;
    for (const table of ['MediaStorage', 'MediaThumbnail', 'MediaVersion']) {
      try {
        const r = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*) AS n FROM ${q(table)} WHERE \`path\` = ? AND \`shopId\` <> ?`, stored, shop.id);
        others += Number(r[0]?.n ?? 0);
      } catch {
        /* absent scaffolding table */
      }
    }
    if (others > 0) shared.add(stored);
  }

  await db.$transaction(
    async (tx) => {
      deleted.RefreshToken = await tx.$executeRawUnsafe('DELETE FROM `RefreshToken` WHERE `userId` IN (SELECT `id` FROM `User` WHERE `shopId` = ?)', shop.id);
      deleted.PasswordResetToken = await tx.$executeRawUnsafe('DELETE FROM `PasswordResetToken` WHERE `userId` IN (SELECT `id` FROM `User` WHERE `shopId` = ?)', shop.id);
      deleted.LoginAttempt = await tx.$executeRawUnsafe('DELETE FROM `LoginAttempt` WHERE `userId` IN (SELECT `id` FROM `User` WHERE `shopId` = ?)', shop.id);
      for (const table of ['Invitation', 'Notification', 'SearchHistory']) {
        deleted[table] = await tx.$executeRawUnsafe(`DELETE FROM ${q(table)} WHERE \`shopId\` = ?`, shop.id);
      }
      for (const s of statements) {
        const n = await tx.$executeRawUnsafe(s.sql, ...s.params);
        if (n > 0) rows[s.model] = n;
      }
      if (shop.ownerId) {
        await tx.$executeRawUnsafe(
          'INSERT INTO `AuditLog` (`id`, `shopId`, `userId`, `action`, `entity`, `entityId`, `afterData`, `createdAt`) VALUES (?, ?, ?, \'SHOP_ERASED\', \'Shop\', ?, ?, ?)',
          randomUUID(),
          shop.id,
          shop.ownerId,
          shop.id,
          JSON.stringify({ rows, deleted }),
          options.now,
        );
      }
    },
    { timeout: 10 * 60_000, maxWait: 30_000 },
  );

  // The receipt counts what was removed, not what was asked for (audit P3):
  // a media path whose file is already gone is not a removed file.
  let removed = 0;
  for (const target of files) {
    if (await removeIfPresent(target)) removed++;
  }
  const kept: string[] = [];
  for (const stored of media) {
    if (shared.has(stored)) {
      kept.push(stored);
      continue;
    }
    if (await removeIfPresent(resolveUnder(options.workingDirectory, stored))) removed++;
  }
  return { kind: 'shop', shopId: shop.id, executedAt: options.now.toISOString(), dryRun: false, rows, deleted, files: { removed, kept }, legalHold: [] };
}

export interface EraseCustomerOptions extends Pick<ShopDataPaths, 'storageRoot'> {
  shopId: string;
  customerId: string;
  now: Date;
  dryRun: boolean;
  /** The API's `uploads` directory: import files that hold the customer are removed (audit F3). */
  uploadsRoot?: string;
}

/** Fields a GST legal hold keeps on the customer's row (Rule 46(e) proviso: name and address of the recipient). */
const HELD_FIELDS = new Set(['Customer.name', 'Customer.address', 'Customer.city']);

/** How the customer appears in an import: the national phone number, and the email when there is one. */
interface CustomerKeys {
  phone: string | null;
  email: string | null;
}

function customerKeys(row: { phone: string | null; email: string | null }): CustomerKeys {
  const phone = row.phone ? normalizePhone(row.phone) : null;
  return { phone: phone?.ok ? phone.value : null, email: row.email ? row.email.trim().toLowerCase() : null };
}

/** True when an import row's cells name the customer (its phone, as the import matched it, or its email). */
function rowNamesCustomer(raw: unknown, keys: CustomerKeys): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const cells = raw as Record<string, unknown>;
  const phone = typeof cells.phone === 'string' ? normalizePhone(cells.phone) : null;
  if (keys.phone && phone?.ok && phone.value === keys.phone) return true;
  return !!keys.email && typeof cells.email === 'string' && cells.email.trim().toLowerCase() === keys.email;
}

/** True when a stored import file holds the customer: a line with its phone digits (any spelling) or its email. */
async function fileNamesCustomer(file: string, keys: CustomerKeys): Promise<boolean> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  for (const line of text.split(/\r?\n/)) {
    if (keys.phone && keys.phone.length >= 6 && line.replace(/\D/g, '').includes(keys.phone)) return true;
    if (keys.email && line.toLowerCase().includes(keys.email)) return true;
  }
  return false;
}

/** The report rows of the shop's customer imports that name the customer (their raw cells are the customer's). */
async function customerImportRows(db: Db | Tx, shopId: string, keys: CustomerKeys): Promise<string[]> {
  if (!keys.phone && !keys.email) return [];
  const ids: string[] = [];
  let after = '';
  for (;;) {
    const page = await db.$queryRawUnsafe<Array<{ id: string; rawData: unknown }>>(
      "SELECT r.`id`, r.`rawData` FROM `ImportJobRow` r JOIN `ImportJob` j ON j.`id` = r.`importJobId` WHERE j.`shopId` = ? AND j.`kind` = 'CUSTOMERS' AND r.`id` > ? ORDER BY r.`id` LIMIT 1000",
      shopId,
      after,
    );
    for (const row of page) if (rowNamesCustomer(serialise(row.rawData), keys)) ids.push(row.id);
    if (page.length < 1000) return ids;
    after = page[page.length - 1].id;
  }
}

export async function eraseCustomer(db: Db, options: EraseCustomerOptions): Promise<ErasureReceipt> {
  const shop = await loadShop(db, options.shopId);
  const customers = await db.$queryRawUnsafe<Array<{ id: string; outstandingBalance: Prisma.Decimal; phone: string | null; email: string | null }>>(
    'SELECT `id`, `outstandingBalance`, `phone`, `email` FROM `Customer` WHERE `id` = ? AND `shopId` = ?',
    options.customerId,
    shop.id,
  );
  if (customers.length === 0) throw new ShopDataError(`customer ${options.customerId} does not exist in shop ${shop.id}`);
  const balance = new Prisma.Decimal(customers[0].outstandingBalance.toString());
  if (!balance.isZero()) {
    throw new ShopDataError(`customer ${options.customerId} has an outstanding balance of ${balance.toFixed(2)}: settle it (repayment, or a write-off by the owner) before the erasure`);
  }
  // Read before the row is rewritten: the import rows and files are found by these.
  const keys = customerKeys(customers[0]);

  // Legal hold: a sale of 50,000 rupees or more still in its GST retention period.
  const held = await db.$queryRawUnsafe<Array<{ invoiceNumber: string; financialYear: string; totalAmount: Prisma.Decimal }>>(
    "SELECT `invoiceNumber`, `financialYear`, `totalAmount` FROM `Invoice` WHERE `shopId` = ? AND `customerId` = ? AND `type` = 'SALE' AND `totalAmount` >= ?",
    shop.id,
    options.customerId,
    GST_NAMED_RECIPIENT_THRESHOLD,
  );
  const legalHold = held.filter((i) => gstRetentionEnds(i.financialYear) > options.now).map((i) => `${i.invoiceNumber} (${i.financialYear}, held until ${gstRetentionEnds(i.financialYear).toISOString().slice(0, 10)})`);
  const keep = legalHold.length > 0 ? HELD_FIELDS : undefined;
  // The customer's own rows, the rows that name the customer, and the child
  // tables of the customer (its audit trail, addresses, contacts, documents:
  // audit F3), whose payloads repeat the name and phone.
  const statements = [
    ...erasureStatements({ shopId: shop.id, customerId: options.customerId, keep }, options.now),
    ...childErasureStatements({ shopId: shop.id, customerId: options.customerId, keep }),
  ];
  const folder = path.join(options.storageRoot, shop.id, 'Customers', options.customerId);
  const importRows = await customerImportRows(db, shop.id, keys);
  const importFilesHolding: string[] = [];
  if (options.uploadsRoot) {
    for (const file of await importFiles(options.uploadsRoot, shop.id)) if (await fileNamesCustomer(file, keys)) importFilesHolding.push(file);
  }

  const rows: Record<string, number> = {};
  if (options.dryRun) {
    Object.assign(rows, await countRows(db, statements));
    if (importRows.length > 0) rows.ImportJobRow = (rows.ImportJobRow ?? 0) + importRows.length;
    return {
      kind: 'customer',
      shopId: shop.id,
      customerId: options.customerId,
      executedAt: options.now.toISOString(),
      dryRun: true,
      rows,
      deleted: {},
      files: { removed: (existsSync(folder) ? 1 : 0) + importFilesHolding.length, kept: [] },
      legalHold,
    };
  }

  await db.$transaction(async (tx) => {
    for (const s of statements) {
      const n = await tx.$executeRawUnsafe(s.sql, ...s.params);
      if (n > 0) rows[s.model] = n;
    }
    // The audit trail of the customer keeps what happened, not what the rows said.
    rows.AuditLog = await tx.$executeRawUnsafe(
      "UPDATE `AuditLog` SET `beforeData` = NULL, `afterData` = NULL, `ipAddress` = NULL, `userAgent` = NULL WHERE `shopId` = ? AND `entity` = 'Customer' AND `entityId` = ?",
      shop.id,
      options.customerId,
    );
    // The import report rows that carried the customer's cells (served by GET /imports/jobs/:id/rows|report).
    for (let i = 0; i < importRows.length; i += 500) {
      const batch = importRows.slice(i, i + 500);
      const n = await tx.$executeRawUnsafe(
        `UPDATE \`ImportJobRow\` SET \`rawData\` = '{}', \`errors\` = NULL, \`changes\` = NULL WHERE \`id\` IN (${batch.map(() => '?').join(', ')})`,
        ...batch,
      );
      rows.ImportJobRow = (rows.ImportJobRow ?? 0) + n;
    }
    if (shop.ownerId) {
      await tx.$executeRawUnsafe(
        'INSERT INTO `AuditLog` (`id`, `shopId`, `userId`, `action`, `entity`, `entityId`, `afterData`, `createdAt`) VALUES (?, ?, ?, \'CUSTOMER_ERASED\', \'Customer\', ?, ?, ?)',
        randomUUID(),
        shop.id,
        shop.ownerId,
        options.customerId,
        JSON.stringify({ legalHold: legalHold.length > 0 }),
        options.now,
      );
    }
  });

  // Files: everything of the customer, except the invoices a legal hold keeps,
  // and every uploaded import file that holds the customer.
  let removed = 0;
  const kept: string[] = [];
  if (existsSync(folder)) {
    for (const entry of await fs.readdir(folder)) {
      if (legalHold.length > 0 && entry === 'Invoices') {
        kept.push(path.join('Customers', options.customerId, entry));
        continue;
      }
      if (await removeIfPresent(path.join(folder, entry))) removed++;
    }
    if (kept.length === 0) await fs.rm(folder, { recursive: true, force: true });
  }
  for (const file of importFilesHolding) if (await removeIfPresent(file)) removed++;
  return { kind: 'customer', shopId: shop.id, customerId: options.customerId, executedAt: options.now.toISOString(), dryRun: false, rows, deleted: {}, files: { removed, kept }, legalHold };
}

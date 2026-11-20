import { Prisma } from '@prisma/client';
import { RawQueryClient, shopPathOf } from '../../../src/prisma/cross-shop-audit';

/**
 * Two views of everything one shop owns, for the cross-shop isolation suite:
 * an id inventory (what an attacker in another shop could name) and a
 * fingerprint (proof that nothing of the shop changed while another shop
 * attacked it). Both cover every model with a shop path
 * (`src/prisma/cross-shop-audit.ts`), child tables included, so a model
 * added later is covered without touching this file.
 */

const q = (identifier: string) => `\`${identifier.replace(/`/g, '``')}\``;
const models = Prisma.dmmf.datamodel.models;

interface ScopedModel {
  name: string;
  joins: string;
  expr: string;
  columns: string[];
  hasId: boolean;
}

const SCOPED: ScopedModel[] = models
  .map((m) => {
    const path = shopPathOf(m.name, 'm');
    if (!path) return null;
    return {
      name: m.name,
      joins: path.joins.join(' '),
      expr: path.expr,
      columns: m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name),
      hasId: m.fields.some((f) => f.name === 'id' && f.isId),
    };
  })
  .filter((m): m is ScopedModel => m !== null);

/** Per model: how many rows the shop has and a checksum over every column of them. */
export type ShopFingerprint = Record<string, { rows: number; checksum: string }>;

export async function shopFingerprint(db: RawQueryClient, shopId: string): Promise<ShopFingerprint> {
  const result: ShopFingerprint = {};
  for (const model of SCOPED) {
    const cells = model.columns.map((c) => `COALESCE(CAST(m.${q(c)} AS CHAR), '<null>')`).join(', ');
    const [row] = await db.$queryRawUnsafe<Array<{ n: bigint | number; h: unknown }>>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('#', ${cells}))), 0) AS h FROM ${q(model.name)} m ${model.joins} WHERE ${model.expr} = ?`,
      shopId,
    );
    const rows = Number(row?.n ?? 0);
    if (rows > 0) result[model.name] = { rows, checksum: String(row?.h ?? '0') };
  }
  return result;
}

/** The models whose rows or contents differ between two fingerprints. */
export function fingerprintDiff(before: ShopFingerprint, after: ShopFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((n) => before[n]?.rows !== after[n]?.rows || before[n]?.checksum !== after[n]?.checksum)
    .map((n) => `${n}: ${before[n]?.rows ?? 0} -> ${after[n]?.rows ?? 0} rows${before[n]?.checksum !== after[n]?.checksum ? ', contents changed' : ''}`)
    .sort();
}

/** Up to `perModel` ids of every model the shop has rows of (every id when `perModel` is 0). */
export async function shopIds(db: RawQueryClient, shopId: string, perModel = 3): Promise<Map<string, string[]>> {
  const ids = new Map<string, string[]>();
  for (const model of SCOPED) {
    if (!model.hasId) continue;
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT m.${q('id')} AS id FROM ${q(model.name)} m ${model.joins} WHERE ${model.expr} = ? ORDER BY m.${q('id')}${perModel > 0 ? ` LIMIT ${perModel}` : ''}`,
      shopId,
    );
    if (rows.length > 0) ids.set(model.name, rows.map((r) => String(r.id)));
  }
  return ids;
}

/** Every string column value of the shop's rows of `model` (names, numbers, SKUs): what must never reach another shop. */
export async function shopStrings(db: RawQueryClient, shopId: string, model: string, columns: string[]): Promise<string[]> {
  const scoped = SCOPED.find((m) => m.name === model);
  if (!scoped) throw new Error(`${model} has no shop path`);
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${columns.map((c) => `m.${q(c)} AS ${q(c)}`).join(', ')} FROM ${q(model)} m ${scoped.joins} WHERE ${scoped.expr} = ?`,
    shopId,
  );
  return rows.flatMap((r) => columns.map((c) => r[c])).filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

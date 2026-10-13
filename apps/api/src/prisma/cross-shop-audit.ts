import { Prisma } from '@prisma/client';

/**
 * Proof, from the data itself, that no row of one shop points at a row of
 * another (cross-shop isolation audit, 2026-10-12). Derived from the Prisma
 * schema like `tenant-scope.ts`, so a new model or relation is checked
 * without touching this file:
 *
 * - every model has a shop path: its own `shopId`, the Shop's `id`, or the
 *   path of the parent it hangs off (an invoice line is its invoice's, a
 *   variant attribute value its attribute's), up to three hops;
 * - every to-one relation between two models with a shop path must join rows
 *   of the same shop. A row of shop A that names shop B's customer, product,
 *   user or document is exactly what a missed ownership check leaves behind,
 *   and what an `include` would then hand to shop A.
 *
 * The audit only reads. `node dist/cli/tenant-audit` runs it against any
 * database; the integration suites run it after attacking every route.
 */

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS: ReadonlyMap<string, DmmfModel> = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const MAX_HOPS = 3;

/** How a row names its shop: SQL joins (from `alias`) and the expression that yields the shop id. */
export interface ShopPath {
  joins: string[];
  expr: string;
  /** The relation the path leaves through (none for a model with its own shopId, or the Shop). */
  via?: string;
}

const q = (identifier: string) => `\`${identifier.replace(/`/g, '``')}\``;
const hasShopColumn = (model: DmmfModel) => model.fields.some((f) => f.kind === 'scalar' && f.name === 'shopId');

/** To-one relations that store their foreign key on this model (one column). */
function ownedToOneRelations(model: DmmfModel): DmmfField[] {
  return model.fields.filter(
    (f) => f.kind === 'object' && !f.isList && (f.relationFromFields?.length ?? 0) === 1 && (f.relationToFields?.length ?? 0) === 1,
  );
}

/**
 * The shop path of `modelName` read from `alias`, or null when the model has
 * no way to a shop (a global table such as an idempotency record).
 */
export function shopPathOf(modelName: string, alias: string, hops = 0, seen: ReadonlySet<string> = new Set()): ShopPath | null {
  const model = MODELS.get(modelName);
  if (!model) return null;
  if (modelName === 'Shop') return { joins: [], expr: `${alias}.${q('id')}` };
  if (hasShopColumn(model)) return { joins: [], expr: `${alias}.${q('shopId')}` };
  if (hops >= MAX_HOPS) return null;
  const relations = ownedToOneRelations(model)
    .filter((f) => f.type !== modelName && !seen.has(f.type))
    .sort((a, b) => Number(b.isRequired) - Number(a.isRequired));
  for (const relation of relations) {
    const parentAlias = `${alias}_${hops}`;
    const parent = shopPathOf(relation.type, parentAlias, hops + 1, new Set([...seen, modelName]));
    if (!parent) continue;
    const join = `${relation.isRequired ? 'JOIN' : 'LEFT JOIN'} ${q(relation.type)} ${parentAlias} ON ${parentAlias}.${q(relation.relationToFields![0])} = ${alias}.${q(relation.relationFromFields![0])}`;
    return { joins: [join, ...parent.joins], expr: parent.expr, via: relation.name };
  }
  return null;
}

/** One relation the audit checks. */
export interface CrossShopCheck {
  model: string;
  field: string;
  target: string;
  /** `FROM ... WHERE <own shop> <> <target shop>`: the rows of `model` whose `field` names a row of another shop. */
  fromWhere: string;
  /** The row's key columns, for the report. */
  keySelect: string;
  /** The SQL expressions of the two shops (the row's own, the referenced row's). */
  ownShop: string;
  targetShop: string;
}

/**
 * Every relation the audit checks. Links to the Shop row itself are left out
 * (a shop path ends there by definition), and so is the relation a child
 * model's own path goes through (it defines that row's shop).
 */
export function crossShopChecks(): CrossShopCheck[] {
  const checks: CrossShopCheck[] = [];
  for (const model of MODELS.values()) {
    const own = shopPathOf(model.name, 'm');
    if (!own) continue;
    const key = model.fields.filter((f) => f.isId).map((f) => f.name);
    const keyColumns = (key.length > 0 ? key : model.primaryKey?.fields ?? []).map((c) => `m.${q(c)}`);
    for (const relation of ownedToOneRelations(model)) {
      if (relation.type === 'Shop' || relation.name === own.via) continue;
      const target = shopPathOf(relation.type, 'r');
      if (!target) continue;
      checks.push({
        model: model.name,
        field: relation.name,
        target: relation.type,
        fromWhere: [
          `FROM ${q(model.name)} m`,
          ...own.joins,
          `JOIN ${q(relation.type)} r ON r.${q(relation.relationToFields![0])} = m.${q(relation.relationFromFields![0])}`,
          ...target.joins,
          `WHERE ${own.expr} <> ${target.expr}`,
        ].join(' '),
        keySelect: keyColumns.length > 0 ? keyColumns.join(', ') : 'm.*',
        ownShop: own.expr,
        targetShop: target.expr,
      });
    }
  }
  return checks.sort((a, b) => `${a.model}.${a.field}`.localeCompare(`${b.model}.${b.field}`));
}

/** A relation that joins rows of two shops. */
export interface CrossShopFinding {
  model: string;
  field: string;
  target: string;
  rows: number;
  sample: Array<Record<string, unknown>>;
}

export interface CrossShopAuditResult {
  checked: number;
  findings: CrossShopFinding[];
}

/** Anything with Prisma's unsafe raw query (a PrismaClient or a transaction). */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Runs every check; a clean database answers no findings. `shops` narrows
 * the audit to rows with one of those shops on either side (a suite auditing
 * what it did, on a database other suites share).
 */
export async function auditCrossShopReferences(db: RawQueryClient, options: { shops?: string[] } = {}): Promise<CrossShopAuditResult> {
  const checks = crossShopChecks();
  const findings: CrossShopFinding[] = [];
  const shops = options.shops ?? [];
  const list = shops.map(() => '?').join(', ');
  for (const check of checks) {
    const where = shops.length === 0 ? check.fromWhere : `${check.fromWhere} AND (${check.ownShop} IN (${list}) OR ${check.targetShop} IN (${list}))`;
    const params = shops.length === 0 ? [] : [...shops, ...shops];
    const [row] = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT COUNT(*) AS n ${where}`, ...params);
    const rows = Number(row?.n ?? 0);
    if (rows === 0) continue;
    const sample = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${check.keySelect}, ${check.ownShop} AS ownShop, ${check.targetShop} AS targetShop ${where} LIMIT 5`, ...params);
    findings.push({ model: check.model, field: check.field, target: check.target, rows, sample });
  }
  return { checked: checks.length, findings };
}

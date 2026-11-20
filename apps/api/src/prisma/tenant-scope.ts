import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Tenant scoping rules, derived from the Prisma schema (DMMF) instead of a
 * hand-kept allowlist: every model that carries a `shopId` column is
 * tenant-owned unless it is listed in GLOBAL_MODELS.
 *
 * `scopeTenantArgs` is pure so it can be unit-tested without a database; the
 * Prisma client extension in prisma-tenant.extension.ts applies it.
 */

/**
 * Models that carry `shopId` but must stay reachable without a tenant
 * context, because they are read before the tenant is known: the user record
 * is resolved during JWT validation, and an invitation is accepted by token
 * from an unauthenticated request. Add a model here only with such a reason.
 */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set(['User', 'Invitation']);

interface RelationRef {
  field: string;
  target: string;
  isList: boolean;
}

const models = Prisma.dmmf.datamodel.models;

export const TENANT_MODELS: ReadonlySet<string> = new Set(
  models.filter((m) => m.fields.some((f) => f.name === 'shopId') && !GLOBAL_MODELS.has(m.name)).map((m) => m.name),
);

/** Relation fields, per model, whose target is tenant-owned (or the Shop itself). */
const RELATIONS: ReadonlyMap<string, RelationRef[]> = new Map(
  models.map((m) => [
    m.name,
    m.fields
      .filter((f) => f.kind === 'object' && (TENANT_MODELS.has(f.type) || f.type === 'Shop'))
      .map((f) => ({ field: f.name, target: f.type, isList: f.isList })),
  ]),
);

export function isTenantModel(model: string | undefined): boolean {
  return Boolean(model && TENANT_MODELS.has(model));
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'count',
  'aggregate',
  'groupBy',
]);

function violation(message: string): never {
  throw new ForbiddenException(`Cross-tenant violation: ${message}`);
}

/** Adds `shopId` to a where/unique filter; refuses a filter that names another shop. */
function scopeWhere(where: unknown, shopId: string, what: string): Obj {
  const target = isObject(where) ? where : {};
  if (target.shopId !== undefined && target.shopId !== shopId) violation(`${what} names shopId ${String(target.shopId)}`);
  target.shopId = shopId;
  return target;
}

/** Enforces `shopId` (or `shop.connect`) on data that creates a row of a tenant model. */
function scopeCreateData(model: string, data: Obj, shopId: string): void {
  if (TENANT_MODELS.has(model)) {
    if (isObject(data.shop)) {
      // `shop: { connect }` binds the row (checked in scopeNestedWrites); Prisma refuses shopId next to it.
    } else {
      if (data.shopId !== undefined && data.shopId !== shopId) violation(`create on ${model} injects shopId ${String(data.shopId)}`);
      data.shopId = shopId;
    }
  }
  scopeNestedWrites(model, data, shopId);
}

/** Refuses to move a row to another shop and scopes nested writes in update data. */
function scopeUpdateData(model: string, data: Obj, shopId: string): void {
  if (TENANT_MODELS.has(model) && data.shopId !== undefined) {
    if (data.shopId !== shopId) violation(`update on ${model} sets shopId ${String(data.shopId)}`);
    delete data.shopId; // a no-op write, dropped so it can never race an ownership change
  }
  scopeNestedWrites(model, data, shopId);
}

/** A relation to Shop may only `connect` the caller's own shop (a no-op link); anything else moves data across tenants. */
function assertOwnShopLink(model: string, field: string, value: Obj, shopId: string): void {
  const connect = value.connect;
  const connectedId = isObject(connect) ? connect.id : undefined;
  if (Object.keys(value).some((k) => k !== 'connect') || connectedId !== shopId) {
    violation(`${model}.${field} links a shop other than the caller's`);
  }
}

/**
 * Walks the relation fields of `data` whose target is tenant-owned: nested
 * creates get the caller's shopId, nested where/connect filters are narrowed
 * to it (Prisma answers P2025 when the target belongs to another shop).
 */
function scopeNestedWrites(model: string, data: Obj, shopId: string): void {
  for (const relation of RELATIONS.get(model) ?? []) {
    const value = data[relation.field];
    if (!isObject(value)) continue;
    if (relation.target === 'Shop') {
      assertOwnShopLink(model, relation.field, value, shopId);
      continue;
    }
    const target = relation.target;

    if (value.create !== undefined) for (const row of asArray(value.create)) if (isObject(row)) scopeCreateData(target, row, shopId);
    if (isObject(value.createMany) && value.createMany.data !== undefined) {
      for (const row of asArray(value.createMany.data)) if (isObject(row)) scopeCreateData(target, row, shopId);
    }
    if (value.connectOrCreate !== undefined) {
      for (const entry of asArray(value.connectOrCreate)) {
        if (!isObject(entry)) continue;
        entry.where = scopeWhere(entry.where, shopId, `${model}.${relation.field}.connectOrCreate`);
        if (isObject(entry.create)) scopeCreateData(target, entry.create, shopId);
      }
    }
    for (const key of ['connect', 'set', 'disconnect', 'delete'] as const) {
      const filter = value[key];
      if (filter === undefined || typeof filter === 'boolean') continue;
      value[key] = Array.isArray(filter)
        ? filter.map((w) => scopeWhere(w, shopId, `${model}.${relation.field}.${key}`))
        : scopeWhere(filter, shopId, `${model}.${relation.field}.${key}`);
    }
    if (value.deleteMany !== undefined) {
      value.deleteMany = asArray(value.deleteMany).map((w) => scopeWhere(w, shopId, `${model}.${relation.field}.deleteMany`));
    }
    if (value.update !== undefined) {
      const entries = asArray(value.update);
      const scoped = entries.map((entry) => {
        if (!isObject(entry)) return entry;
        if (relation.isList || (isObject(entry.data) && Object.keys(entry).every((k) => k === 'where' || k === 'data'))) {
          entry.where = scopeWhere(entry.where, shopId, `${model}.${relation.field}.update`);
          if (isObject(entry.data)) scopeUpdateData(target, entry.data, shopId);
        } else {
          scopeUpdateData(target, entry, shopId); // to-one shorthand: the entry is the data
        }
        return entry;
      });
      value.update = Array.isArray(value.update) ? scoped : scoped[0];
    }
    if (value.updateMany !== undefined) {
      for (const entry of asArray(value.updateMany)) {
        if (!isObject(entry)) continue;
        entry.where = scopeWhere(entry.where, shopId, `${model}.${relation.field}.updateMany`);
        if (isObject(entry.data)) scopeUpdateData(target, entry.data, shopId);
      }
    }
    if (value.upsert !== undefined) {
      for (const entry of asArray(value.upsert)) {
        if (!isObject(entry)) continue;
        if (relation.isList || entry.where !== undefined) entry.where = scopeWhere(entry.where, shopId, `${model}.${relation.field}.upsert`);
        if (isObject(entry.create)) scopeCreateData(target, entry.create, shopId);
        if (isObject(entry.update)) scopeUpdateData(target, entry.update, shopId);
      }
    }
  }
}

/**
 * Rewrites the arguments of one Prisma operation so it can only touch rows of
 * `shopId`. Top-level filters get `shopId`, creates get it injected, updates
 * may not change it, and nested writes into tenant models are scoped the same
 * way. Mutates and returns `args`.
 */
export function scopeTenantArgs(model: string, operation: string, args: unknown, shopId: string): Obj {
  const scoped: Obj = isObject(args) ? args : {};
  const tenantModel = TENANT_MODELS.has(model);

  if (operation === 'create' || operation === 'createMany' || operation === 'createManyAndReturn') {
    if (scoped.data !== undefined) for (const row of asArray(scoped.data)) if (isObject(row)) scopeCreateData(model, row, shopId);
  }
  if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    if (isObject(scoped.data)) scopeUpdateData(model, scoped.data, shopId);
  }
  if (operation === 'upsert') {
    if (isObject(scoped.create)) scopeCreateData(model, scoped.create, shopId);
    if (isObject(scoped.update)) scopeUpdateData(model, scoped.update, shopId);
  }
  if (tenantModel && WHERE_OPERATIONS.has(operation)) {
    scoped.where = scopeWhere(scoped.where, shopId, `${operation} on ${model}`);
  }
  return scoped;
}

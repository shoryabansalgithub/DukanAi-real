import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Soft-delete tokens (roadmap 3.10, audit P2-32). A unique key that includes
 * the nullable `deletedAt` never blocks a duplicate on MySQL (NULLs are
 * distinct), so the models below carry a NOT NULL `deletedToken`: '' while
 * the row is live, the row's own id once it is soft-deleted. The unique keys
 * are `(shopId, <key>, deletedToken)`, so two live rows cannot share a key
 * while a deleted row never blocks the key from being reused.
 *
 * `stampDeletedToken` is pure and derived from the schema: every model with
 * a `deletedToken` field is covered, so a new model needs no registration.
 * A soft delete is any `update`/`upsert` whose data sets `isDeleted: true` or
 * a non-null `deletedAt`; a restore (`isDeleted: false` or `deletedAt: null`)
 * clears the token, which makes the row compete for its key again (P2002 ->
 * 409 if the key was reused meanwhile).
 */
export const DELETED_TOKEN_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'deletedToken')).map((m) => m.name),
);

type Obj = Record<string, unknown>;

function deletionIntent(data: Obj | undefined): 'delete' | 'restore' | null {
  if (!data) return null;
  const isDeleted = unwrapSet(data.isDeleted);
  const deletedAt = unwrapSet(data.deletedAt);
  if (isDeleted === true || (deletedAt !== undefined && deletedAt !== null)) return 'delete';
  if (isDeleted === false || deletedAt === null) return 'restore';
  return null;
}

function unwrapSet(value: unknown): unknown {
  if (value && typeof value === 'object' && 'set' in (value as Obj)) return (value as Obj).set;
  return value;
}

/** Returns the args with `deletedToken` stamped where the write soft-deletes or restores a row. */
export function stampDeletedToken(model: string | undefined, operation: string, args: unknown): unknown {
  if (!model || !DELETED_TOKEN_MODELS.has(model) || !args || typeof args !== 'object') return args;
  const a = args as Obj;
  if (operation === 'update' || operation === 'upsert') {
    const key = operation === 'upsert' ? 'update' : 'data';
    const data = a[key] as Obj | undefined;
    const intent = deletionIntent(data);
    if (!intent || data === undefined) return args;
    if (intent === 'restore') return { ...a, [key]: { ...data, deletedToken: '' } };
    const id = (a.where as Obj | undefined)?.id;
    if (typeof id !== 'string') {
      throw new InternalServerErrorException(`Soft delete of ${model} must address the row by id so its deletedToken can be stamped.`);
    }
    return { ...a, [key]: { ...data, deletedToken: id } };
  }
  if (operation === 'updateMany') {
    const intent = deletionIntent(a.data as Obj | undefined);
    if (intent === 'delete') {
      throw new InternalServerErrorException(`Soft delete of ${model} must use update by id (updateMany cannot stamp deletedToken).`);
    }
    if (intent === 'restore') return { ...a, data: { ...(a.data as Obj), deletedToken: '' } };
  }
  return args;
}

export function softDeleteTokenExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            return query(stampDeletedToken(model, operation, args) as typeof args);
          },
        },
      },
    }),
  );
}

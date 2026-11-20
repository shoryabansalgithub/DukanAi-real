import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** Model delegates that expose `findFirst` / `findMany`, on the client or inside a transaction. */
type Db = PrismaClient | Prisma.TransactionClient;
type ModelName = Uncapitalize<Prisma.ModelName>;

interface Delegate {
  findFirst(args: { where: Record<string, unknown>; select: { id: true } }): Promise<{ id: string } | null>;
  findMany(args: { where: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }[]>;
}

const delegate = (db: Db, model: ModelName): Delegate => (db as unknown as Record<string, Delegate>)[model];

const label = (model: ModelName) => model.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/**
 * Foreign-key ownership check (roadmap 1.5): an ID supplied in a request
 * body must name a row of the caller's shop. The tenant extension already
 * narrows reads to the shop, but a foreign key written into a new row is
 * never read, so it must be checked explicitly, before the write, inside the
 * same transaction. Answers 404 like any other lookup of a foreign row, so
 * the existence of other shops' IDs is not confirmed.
 */
export async function assertOwned(db: Db, model: ModelName, id: string | null | undefined, shopId: string, extraWhere: Record<string, unknown> = {}): Promise<void> {
  if (id === null || id === undefined) return;
  const row = await delegate(db, model).findFirst({ where: { id, shopId, ...extraWhere }, select: { id: true } });
  if (!row) throw new NotFoundException(`${label(model)} ${id} not found`);
}

/** `assertOwned` for a list of IDs in one query; `undefined`/`null` entries are ignored. */
export async function assertOwnedMany(db: Db, model: ModelName, ids: Array<string | null | undefined>, shopId: string, extraWhere: Record<string, unknown> = {}): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) return;
  const rows = await delegate(db, model).findMany({ where: { id: { in: wanted }, shopId, ...extraWhere }, select: { id: true } });
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length) throw new NotFoundException(`${label(model)} ${missing.join(', ')} not found`);
}

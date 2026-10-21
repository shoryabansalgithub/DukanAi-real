import { Prisma } from '@prisma/client';

/**
 * Keyset pagination for the stock reconciliation scan (roadmap 5.4). The
 * former loop paged with `skip`, which re-reads every earlier page on each
 * step (O(n²) over the window) and skips or repeats rows when a product's
 * `updatedAt` moves between two pages. The batches now walk the
 * `Product(updatedAt)` index in `(updatedAt, id)` order from a cursor:
 * each page is one range read, and a row is visited at most once per run.
 *
 * The window is closed at `runStart`: a product updated while the run is in
 * progress (including one the run itself repairs, which bumps `updatedAt`)
 * falls outside it and is picked up by the next run, so the loop always
 * terminates even under continuous sales.
 */
export interface ReconCursor {
  updatedAt: Date;
  id: string;
}

export function reconBatchWhere(lookbackStart: Date, runStart: Date, cursor: ReconCursor | null): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {
    isDeleted: false,
    updatedAt: { gte: lookbackStart, lte: runStart },
  };
  if (cursor) {
    where.OR = [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }];
  }
  return where;
}

export const RECON_BATCH_ORDER: Prisma.ProductOrderByWithRelationInput[] = [{ updatedAt: 'asc' }, { id: 'asc' }];

/** The cursor for the page after `rows` (the last row of the page), or null when the page was empty. */
export function nextReconCursor<T extends ReconCursor>(rows: T[]): ReconCursor | null {
  const last = rows[rows.length - 1];
  return last ? { updatedAt: last.updatedAt, id: last.id } : null;
}

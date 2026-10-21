import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'stockLedgerEntry'>;

/**
 * What a counted shelf should have held when it was counted (release audit
 * S1). A count session snapshots `InventoryItem.onHand` when it starts
 * (`StockCountItem.expectedQuantity`), but the shop keeps selling and
 * receiving while people count: every stock movement of the item between the
 * snapshot (`StockCountSession.startedAt`) and the moment the item was
 * counted (`StockCountItem.countedAt`) belongs to the expected quantity.
 * Movements after the count do not: they happened to the counted stock.
 *
 * The variance is then counted − expected-at-count, and an approved
 * adjustment posts exactly that as the delta to the current stock, so a sale
 * during the count is not subtracted twice (once by the sale, once by the
 * stale variance).
 */
export async function netMovementBetween(db: Db, shopId: string, inventoryItemId: string, after: Date, upTo: Date): Promise<Prisma.Decimal> {
  const sum = await db.stockLedgerEntry.aggregate({
    where: { shopId, inventoryItemId, createdAt: { gt: after, lte: upTo } },
    _sum: { quantity: true },
  });
  return sum._sum.quantity ?? new Prisma.Decimal(0);
}

export interface CountedItem {
  shopId: string;
  inventoryItemId: string;
  expectedQuantity: Prisma.Decimal;
  countedQuantity: Prisma.Decimal | null;
  countedAt: Date | null;
}

export interface CountSessionTimes {
  startedAt: Date | null;
  createdAt: Date;
}

/** Snapshot + net movements of the item between the snapshot and the count. */
export async function expectedAtCount(db: Db, item: CountedItem, session: CountSessionTimes, countedAt: Date): Promise<Prisma.Decimal> {
  const snapshotAt = session.startedAt ?? session.createdAt;
  const moved = await netMovementBetween(db, item.shopId, item.inventoryItemId, snapshotAt, countedAt);
  return item.expectedQuantity.plus(moved);
}

/** counted − expected-at-count, or null for an item that was not counted yet. */
export async function countVariance(db: Db, item: CountedItem, session: CountSessionTimes): Promise<Prisma.Decimal | null> {
  if (item.countedQuantity === null || item.countedAt === null) return null;
  const expected = await expectedAtCount(db, item, session, item.countedAt);
  return item.countedQuantity.minus(expected);
}

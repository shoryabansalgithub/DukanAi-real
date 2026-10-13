import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateStockCountSessionDto } from '../dto/stock-count.dto';
import { CountSessionStatus, Prisma } from '@prisma/client';
import { assertOwned } from '../../prisma/tenant-ownership';
import { Clock } from '../../common/time/clock';
import { withSerializationRetry } from '../../common/db/serialization-retry';

@Injectable()
export class StockCountService {
  private readonly logger = new Logger(StockCountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * Initializes a count session and SNAPSHOTS the expected quantities.
   *
   * The items in scope are read with a shared lock (`LOCK IN SHARE MODE`):
   * a stock mutation in flight on one of them commits before the read, and
   * the next one waits until this transaction has committed. The snapshot
   * instant (`startedAt`) is taken after that read, so every movement the
   * snapshot holds has a stock-ledger time before it and every later one a
   * time after it; the variance of an item counted later adds exactly the
   * movements in between (`count-expectation.ts`, release audit S1).
   */
  async startCountSession(shopId: string, dto: CreateStockCountSessionDto) {
    return withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          await assertOwned(tx, 'warehouse', dto.warehouseId, shopId);
          await assertOwned(tx, 'user', dto.assignedToUserId, shopId, { isDeleted: false });

          // Items to count based on scope (one warehouse, or the whole shop), read under a shared lock.
          const inventoryItems = await tx.$queryRaw<Array<{ id: string; onHand: Prisma.Decimal | string }>>`
            SELECT i.id, i.onHand FROM InventoryItem i
            JOIN Location l ON l.id = i.locationId
            WHERE i.shopId = ${shopId} AND i.isDeleted = false
            ${dto.warehouseId ? Prisma.sql`AND l.warehouseId = ${dto.warehouseId}` : Prisma.empty}
            ORDER BY i.id
            LOCK IN SHARE MODE
          `;
          const snapshotAt = this.clock.now();

          const session = await tx.stockCountSession.create({
            data: {
              shopId,
              warehouseId: dto.warehouseId,
              type: dto.type,
              status: CountSessionStatus.IN_PROGRESS,
              assignedToUserId: dto.assignedToUserId,
              startedAt: snapshotAt,
            },
          });

          const countItemsData = inventoryItems.map((item) => ({
            shopId,
            sessionId: session.id,
            inventoryItemId: item.id,
            expectedQuantity: new Prisma.Decimal(item.onHand.toString()),
          }));
          if (countItemsData.length > 0) {
            await tx.stockCountItem.createMany({ data: countItemsData });
          }

          this.logger.log(`Count Session ${session.id} started with ${countItemsData.length} items snapshotted.`);
          return session;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000, maxWait: 15_000 },
      ),
    );
  }

  async completeCountSession(shopId: string, sessionId: string) {
    return this.prisma.stockCountSession.update({
      where: { id: sessionId, shopId },
      data: {
        status: CountSessionStatus.UNDER_REVIEW,
        completedAt: this.clock.now()
      }
    });
  }
}

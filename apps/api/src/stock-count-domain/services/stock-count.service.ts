import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateStockCountSessionDto } from '../dto/stock-count.dto';
import { CountSessionStatus } from '@prisma/client';
import { assertOwned } from '../../prisma/tenant-ownership';

@Injectable()
export class StockCountService {
  private readonly logger = new Logger(StockCountService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initializes a count session and SNAPSHOTS the expected quantities.
   * This is critical: If physical operations continue, the expected baseline 
   * must not drift during the count.
   */
  async startCountSession(shopId: string, dto: CreateStockCountSessionDto) {
    return this.prisma.$transaction(async (tx) => {
      await assertOwned(tx, 'warehouse', dto.warehouseId, shopId);
      await assertOwned(tx, 'user', dto.assignedToUserId, shopId, { isDeleted: false });
      
      const session = await tx.stockCountSession.create({
        data: {
          shopId,
          warehouseId: dto.warehouseId,
          type: dto.type,
          status: CountSessionStatus.IN_PROGRESS,
          assignedToUserId: dto.assignedToUserId,
          startedAt: new Date(),
        }
      });

      // Find items to count based on scope (Warehouse)
      const inventoryItems = await tx.inventoryItem.findMany({
        where: {
          shopId,
          location: dto.warehouseId ? { warehouseId: dto.warehouseId } : undefined,
          isDeleted: false
        }
      });

      // Snapshot the `expectedQuantity` based on the Ledger cache (InventoryItem.onHand)
      const countItemsData = inventoryItems.map(item => ({
        shopId,
        sessionId: session.id,
        inventoryItemId: item.id,
        expectedQuantity: item.onHand
      }));

      if (countItemsData.length > 0) {
        await tx.stockCountItem.createMany({ data: countItemsData });
      }

      this.logger.log(`Count Session ${session.id} started with ${countItemsData.length} items snapshotted.`);
      
      return session;
    });
  }

  async completeCountSession(shopId: string, sessionId: string) {
    return this.prisma.stockCountSession.update({
      where: { id: sessionId, shopId },
      data: {
        status: CountSessionStatus.UNDER_REVIEW,
        completedAt: new Date()
      }
    });
  }
}

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma, BatchStatus } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';

@Injectable()
export class BatchAllocationService {
  private readonly logger = new Logger(BatchAllocationService.name);

  constructor(private readonly inventoryMutationEngine: InventoryMutationEngine) {}

  /**
   * FEFO (First-Expired-First-Out) Allocation Engine
   * Finds the oldest expiring batches first and locks their stock.
   */
  async allocateFefo(
    tx: Prisma.TransactionClient,
    shopId: string,
    reservationItemId: string,
    productId: string,
    variantId: string | null,
    requestedQuantity: number
  ) {
    let remainingToAllocate = requestedQuantity;

    // 1. Fetch available BatchStocks for this product, ordered by Batch Expiry Date (Ascending = FEFO)
    const availableBatchStocks = await tx.batchStock.findMany({
      where: {
        shopId,
        batch: {
          productId,
          variantId: variantId || null,
          status: BatchStatus.AVAILABLE
        }
      },
      include: {
        batch: true,
        inventoryItem: true
      },
      orderBy: {
        batch: { expiryDate: 'asc' } // FEFO Core Logic
      }
    });

    for (const batchStock of availableBatchStocks) {
      if (remainingToAllocate <= 0) break;

      // Calculate what is truly available in this specific batch-bin slice
      const availableInBatch = batchStock.quantity.toNumber() - batchStock.reservedQuantity.toNumber();

      if (availableInBatch > 0) {
        const allocateFromHere = Math.min(availableInBatch, remainingToAllocate);

        // 1. Lock the BatchStock
        await tx.batchStock.update({
          where: { id: batchStock.id },
          data: { reservedQuantity: { increment: allocateFromHere } }
        });

        // 2. Lock the physical InventoryItem via Engine
        await this.inventoryMutationEngine.mutateStock(tx, {
          shopId,
          locationId: batchStock.inventoryItem.locationId,
          productId: batchStock.inventoryItem.productId,
          quantity: allocateFromHere,
          mutationType: MutationType.RESERVATION,
          reason: `FEFO Batch Allocation: ${reservationItemId}`,
          referenceId: reservationItemId,
          performedBy: 'SYSTEM',
          occurredAt: new Date(),
          allowNegative: batchStock.inventoryItem.isNegativeAllowed
        });

        // 3. Create the Reservation Allocation record (Phase 3.2.4)
        await tx.reservationAllocation.create({
          data: {
            shopId,
            reservationItemId,
            inventoryItemId: batchStock.inventoryItemId,
            allocatedQuantity: allocateFromHere
            // We could theoretically add batchStockId to ReservationAllocation, 
            // but for now, inventoryItem locking is sufficient.
          }
        });

        remainingToAllocate -= allocateFromHere;
        this.logger.debug(`FEFO Allocated ${allocateFromHere} from Batch ${batchStock.batch.batchNumber}`);
      }
    }

    if (remainingToAllocate > 0) {
      throw new BadRequestException(`Insufficient unexpired batch stock! Missing ${remainingToAllocate} units.`);
    }
  }
}

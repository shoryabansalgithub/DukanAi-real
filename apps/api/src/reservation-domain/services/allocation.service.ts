import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Prisma, AllocationStatus } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';

@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  constructor(private readonly inventoryMutationEngine: InventoryMutationEngine) {}

  /**
   * Performs physical stock allocation for a reservation item using a FIFO strategy 
   * (older warehouse locations are exhausted before newer ones).
   * MUST be executed inside a Prisma transaction.
   */
  async allocateStockFifo(
    tx: Prisma.TransactionClient,
    shopId: string,
    reservationItemId: string,
    productId: string,
    variantId: string | null,
    requestedQuantity: Prisma.Decimal | number | string
  ) {
    // Decimal throughout (release audit S16): 1.1 across 0.9 + 0.2 in floats leaves 1.1 − 0.9 = 0.20000000000000007.
    let remainingToAllocate = new Prisma.Decimal(requestedQuantity.toString());

    // Fetch available inventory items, sorted by oldest location first (FIFO)
    const inventoryItems = await tx.inventoryItem.findMany({
      where: {
        shopId,
        productId,
        variantId: variantId || null,
        isDeleted: false
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });

    for (const item of inventoryItems) {
      if (remainingToAllocate.lessThanOrEqualTo(0)) break;

      const availableAtLocation = item.onHand.minus(item.reserved);

      if (availableAtLocation.greaterThan(0)) {
        const allocateFromHere = Prisma.Decimal.min(availableAtLocation, remainingToAllocate);

        // 1. Create the physical allocation lock
        await tx.reservationAllocation.create({
          data: {
            shopId,
            reservationItemId,
            inventoryItemId: item.id,
            allocatedQuantity: allocateFromHere,
            status: AllocationStatus.LOCKED
          }
        });

        // 2. Delegate to Engine for safe reservation update
        await this.inventoryMutationEngine.mutateStock(tx, {
          shopId,
          locationId: item.locationId,
          productId: item.productId,
          variantId: item.variantId,
          quantity: allocateFromHere.toNumber(),
          mutationType: MutationType.RESERVATION,
          reason: `Reservation allocation: ${reservationItemId}`,
          referenceId: reservationItemId,
          performedBy: 'SYSTEM',
          occurredAt: new Date(),
          allowNegative: item.isNegativeAllowed
        });

        // (We do not emit a StockLedgerEntry here because this is merely a reservation lock, not a final deduction).

        remainingToAllocate = remainingToAllocate.minus(allocateFromHere);
      }
    }

    if (remainingToAllocate.greaterThan(0)) {
      throw new ConflictException({ message: `Could not allocate ${remainingToAllocate.toString()} units across physical locations.`, code: 'INSUFFICIENT_STOCK', details: { missing: remainingToAllocate.toString() } });
    }
  }
}

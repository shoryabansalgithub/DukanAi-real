import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ReservationStatus, AllocationStatus } from '@prisma/client';

type ExpiredReservation = Prisma.StockReservationGetPayload<{ include: { items: { include: { allocations: true } } } }>;
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';

@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryMutationEngine: InventoryMutationEngine
  ) {}

  /**
   * Releases one shop's expired reservations and their physical locks. Always
   * per shop: the route passes the caller's shop and the
   * ReservationExpirySweepScheduler passes each shop in turn. Each
   * reservation is released in its own transaction, so one bad row never
   * blocks the rest of the sweep.
   */
  async releaseExpiredReservations(shopId: string) {
    this.logger.log(`Starting Sweep for Expired Reservations in shop ${shopId}...`);

    const now = new Date();

    const expiredReservations = await this.prisma.stockReservation.findMany({
      where: {
        shopId,
        status: { in: [ReservationStatus.ALLOCATED, ReservationStatus.RESERVED] },
        expiresAt: { lte: now }
      },
      include: {
        items: {
          include: { allocations: true }
        }
      }
    });

    if (expiredReservations.length === 0) return 0;

    let releasedCount = 0;

    for (const res of expiredReservations) {
      try {
        await this.releaseOne(res, now);
        releasedCount++;
      } catch (error: unknown) {
        this.logger.error(`Failed to release expired reservation ${res.id} (shop ${shopId}): ${(error as Error).message}`);
      }
    }

    return releasedCount;
  }

  /** Reservation states that still hold stock and can be cancelled or released. */
  static readonly ACTIVE_STATUSES: ReservationStatus[] = [
    ReservationStatus.CREATED,
    ReservationStatus.PENDING,
    ReservationStatus.PARTIALLY_RESERVED,
    ReservationStatus.RESERVED,
    ReservationStatus.PARTIALLY_ALLOCATED,
    ReservationStatus.ALLOCATED,
  ];

  /**
   * Frees the stock of one active reservation of the caller's shop and closes
   * it as CANCELLED (the order was abandoned) or RELEASED (the hold is no
   * longer needed). A reservation that is not active answers 409.
   */
  async releaseReservation(shopId: string, reservationId: string, status: 'CANCELLED' | 'RELEASED', actorId: string): Promise<{ id: string; status: ReservationStatus; releasedAt: Date }> {
    const res = await this.prisma.stockReservation.findFirst({ where: { id: reservationId, shopId }, include: { items: { include: { allocations: true } } } });
    if (!res) throw new NotFoundException({ message: 'Reservation not found.', code: 'RESERVATION_NOT_FOUND' });
    if (!ReservationExpiryService.ACTIVE_STATUSES.includes(res.status)) {
      throw new ConflictException({ message: `Reservation is ${res.status} and holds no stock.`, code: 'RESERVATION_NOT_ACTIVE' });
    }
    const now = new Date();
    await this.releaseOne(res, now, ReservationStatus[status], actorId);
    return { id: res.id, status: ReservationStatus[status], releasedAt: now };
  }

  private async releaseOne(res: ExpiredReservation, now: Date, finalStatus: ReservationStatus = ReservationStatus.EXPIRED, actorId = 'SYSTEM_SWEEP'): Promise<void> {
    {
      await this.prisma.$transaction(async (tx) => {
        for (const item of res.items) {
          for (const allocation of item.allocations) {
            // 1. Release the lock status; an allocation already released (a
            //    concurrent sweep or cancel) must not free stock twice.
            const released = await tx.reservationAllocation.updateMany({
              where: { id: allocation.id, status: AllocationStatus.LOCKED },
              data: { status: AllocationStatus.RELEASED }
            });
            if (released.count === 0) continue;

            // 2. Delegate to Engine to free up Available stock
            const invItem = await tx.inventoryItem.findUnique({ where: { id: allocation.inventoryItemId }});
            if (invItem) {
              await this.inventoryMutationEngine.mutateStock(tx, {
                shopId: res.shopId,
                locationId: invItem.locationId,
                productId: invItem.productId,
                variantId: invItem.variantId,
                quantity: allocation.allocatedQuantity.toNumber(),
                mutationType: MutationType.RESERVATION_RELEASE,
                reason: `Reservation ${finalStatus.toLowerCase()}: ${res.id}`,
                referenceId: res.id,
                performedBy: actorId,
                occurredAt: now,
                allowNegative: true // Releasing should never block
              });
            }
          }
        }

        // 3. Close the header, only if it is still active (a concurrent sweep or cancel wins otherwise).
        const closed = await tx.stockReservation.updateMany({
          where: { id: res.id, shopId: res.shopId, status: { in: ReservationExpiryService.ACTIVE_STATUSES } },
          data: { status: finalStatus, releasedAt: now },
        });
        if (closed.count === 0) throw new ConflictException({ message: 'Reservation was closed concurrently.', code: 'RESERVATION_NOT_ACTIVE' });

        this.logger.debug(`Released expired reservation: ${res.id}`);
      });
    }
  }
}

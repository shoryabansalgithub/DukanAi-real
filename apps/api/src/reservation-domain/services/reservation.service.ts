import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReservationDto } from '../dto/reservation.dto';
import { ReservationValidationService } from './reservation-validation.service';
import { AllocationService } from './allocation.service';
import { ReservationStatus } from '@prisma/client';
import { assertOwnedMany } from '../../prisma/tenant-ownership';

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: ReservationValidationService,
    private readonly allocation: AllocationService
  ) {}

  /**
   * Creates a reservation, locking the inventory physically.
   */
  async createReservation(shopId: string, dto: CreateReservationDto) {
    await assertOwnedMany(this.prisma, 'product', dto.items.map((i) => i.productId), shopId, { isDeleted: false });
    await assertOwnedMany(this.prisma, 'productVariant', dto.items.map((i) => i.variantId), shopId);

    // 1. Pre-flight Validation check (prevent obvious oversells before entering the transaction)
    for (const item of dto.items) {
      await this.validation.validateAvailabilityOrThrow(
        shopId, item.productId, item.variantId || null, item.requestedQuantity
      );
    }

    // 2. Open Serializable Transaction
    return this.prisma.$transaction(async (tx) => {
      
      // Every reservation expires (the DTO bounds the TTL); the per-shop sweep frees the stock.
      const expiresAt = new Date(Date.now() + dto.expiresInSeconds * 1000);

      // 3. Create Reservation Header
      const reservation = await tx.stockReservation.create({
        data: {
          shopId,
          source: dto.source,
          referenceId: dto.referenceId,
          expiresAt,
          status: ReservationStatus.ALLOCATED // We are moving straight to fully allocated
        }
      });

      // 4. Create Items and Allocate Physically
      for (const reqItem of dto.items) {
        const item = await tx.reservationItem.create({
          data: {
            shopId,
            reservationId: reservation.id,
            productId: reqItem.productId,
            variantId: reqItem.variantId,
            requestedQuantity: reqItem.requestedQuantity,
            allocatedQuantity: reqItem.requestedQuantity
          }
        });

        // Run the physical Allocation Strategy (FIFO)
        await this.allocation.allocateStockFifo(
          tx, shopId, item.id, item.productId, item.variantId || null, item.requestedQuantity.toNumber()
        );
        
        // Also update the Product.currentStock cache for Epic 2 backward compatibility
        const product = await tx.product.findUnique({ where: { id: item.productId }});
        if (product && typeof product.currentStock === 'number') {
           // We do NOT decrement currentStock here. Current stock means ON HAND. 
           // We only decrement it when the reservation is FULFILLED.
        }
      }

      // No outbox row: nothing consumed the former `StockReserved` event (roadmap 4.5/4.6).
      return reservation;
    });
  }
}

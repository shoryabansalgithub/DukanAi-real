import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class ReservationValidationService {
  private readonly logger = new Logger(ReservationValidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates if a reservation request can be fulfilled by checking
   * Available = (onHand - reserved) across all locations for this product.
   */
  async validateAvailabilityOrThrow(
    shopId: string, 
    productId: string, 
    variantId: string | null, 
    requestedQuantity: number
  ): Promise<boolean> {
    
    const inventoryItems = await this.prisma.inventoryItem.findMany({
      where: {
        shopId,
        productId,
        variantId: variantId || null,
        isDeleted: false
      }
    });

    // Available = onHand - reserved, in Decimal (release audit S16).
    const totalAvailable = inventoryItems.reduce((sum, item) => sum.plus(item.onHand.minus(item.reserved)), new Prisma.Decimal(0));

    if (totalAvailable.lessThan(requestedQuantity)) {
      this.logger.warn(`Oversell Prevented! Requested: ${requestedQuantity}, Available: ${totalAvailable} for Product ${productId}`);
      throw new BadRequestException(
        `Insufficient stock. Requested ${requestedQuantity}, but only ${totalAvailable} available across all locations.`
      );
    }

    return true;
  }
}

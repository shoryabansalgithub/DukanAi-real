import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CountSessionStatus, Prisma } from '@prisma/client';

@Injectable()
export class VarianceService {
  private readonly logger = new Logger(VarianceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculates and saves the variance for a counted item.
   * Variance = countedQuantity - expectedQuantity.
   */
  async calculateAndSaveVariance(shopId: string, sessionId: string, inventoryItemId: string, countedQuantity: number) {
    const session = await this.prisma.stockCountSession.findFirst({
      where: { id: sessionId, shopId, status: CountSessionStatus.IN_PROGRESS }
    });

    if (!session) throw new NotFoundException('Active Count Session not found.');

    const countItem = await this.prisma.stockCountItem.findFirst({
      where: { shopId, sessionId, inventoryItemId }
    });

    if (!countItem) throw new NotFoundException('Inventory Item is not part of this Count Session.');

    // The core calculation, in decimal arithmetic (quantities carry 3 dp):
    const variance = new Prisma.Decimal(countedQuantity).minus(countItem.expectedQuantity);

    await this.prisma.stockCountItem.update({
      where: { id: countItem.id },
      data: {
        countedQuantity,
        variance
      }
    });

    this.logger.debug(`Calculated Variance for ${inventoryItemId}: Expected ${countItem.expectedQuantity}, Counted ${countedQuantity}, Variance: ${variance}`);

    return { inventoryItemId, variance: variance.toNumber() };
  }
}

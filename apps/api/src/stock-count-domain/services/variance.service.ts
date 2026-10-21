import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CountSessionStatus, Prisma } from '@prisma/client';
import { Clock } from '../../common/time/clock';
import { expectedAtCount } from './count-expectation';

@Injectable()
export class VarianceService {
  private readonly logger = new Logger(VarianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * Records a count and its variance. The expected quantity is the session
   * snapshot plus every stock movement of the item between the snapshot and
   * now (`countedAt`), so sales and receipts during the count are not part
   * of the variance (release audit S1): variance = counted − expected-at-count.
   */
  async calculateAndSaveVariance(shopId: string, sessionId: string, inventoryItemId: string, countedQuantity: number) {
    const session = await this.prisma.stockCountSession.findFirst({
      where: { id: sessionId, shopId, status: CountSessionStatus.IN_PROGRESS }
    });

    if (!session) throw new NotFoundException({ message: 'Active Count Session not found.', code: 'COUNT_SESSION_NOT_FOUND' });

    const countItem = await this.prisma.stockCountItem.findFirst({
      where: { shopId, sessionId, inventoryItemId }
    });

    if (!countItem) throw new NotFoundException({ message: 'Inventory Item is not part of this Count Session.', code: 'COUNT_ITEM_NOT_FOUND' });

    const countedAt = this.clock.now();
    const counted = new Prisma.Decimal(countedQuantity).toDecimalPlaces(3);
    const expected = await expectedAtCount(this.prisma, { ...countItem, countedAt }, session, countedAt);
    const variance = counted.minus(expected);

    await this.prisma.stockCountItem.update({
      where: { id: countItem.id },
      data: {
        countedQuantity: counted,
        variance,
        countedAt,
      }
    });

    this.logger.debug(`Calculated Variance for ${inventoryItemId}: Snapshot ${countItem.expectedQuantity}, expected at count ${expected}, Counted ${counted}, Variance: ${variance}`);

    return { inventoryItemId, expectedQuantity: expected.toNumber(), countedQuantity: counted.toNumber(), variance: variance.toNumber(), countedAt };
  }
}

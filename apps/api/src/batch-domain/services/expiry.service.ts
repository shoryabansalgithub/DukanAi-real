import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BatchStatus } from '@prisma/client';

@Injectable()
export class ExpiryService {
  private readonly logger = new Logger(ExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Quarantines one shop's expired batches so they can no longer be
   * allocated. Always per shop: the route passes the caller's shop and the
   * BatchExpirySweepScheduler passes each shop in turn.
   */
  async quarantineExpiredBatches(shopId: string) {
    this.logger.log(`Starting Expiry Sweep for shop ${shopId}...`);

    const now = new Date();

    const result = await this.prisma.batch.updateMany({
      where: {
        shopId,
        status: BatchStatus.AVAILABLE,
        expiryDate: { lte: now }
      },
      data: {
        status: BatchStatus.EXPIRED
      }
    });

    if (result.count > 0) {
      this.logger.warn(`Quarantined ${result.count} expired batches.`);
    }

    return result.count;
  }
}

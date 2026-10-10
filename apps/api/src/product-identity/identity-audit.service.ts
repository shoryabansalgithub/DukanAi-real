import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ListQueryDto, pageArgs } from '../common/pagination';

@Injectable()
export class IdentityAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a barcode change in the audit ledger and emits an Outbox Event.
   */
  async recordBarcodeChange(
    shopId: string,
    barcodeId: string,
    oldCode: string | null,
    newCode: string,
    reason: string,
    userId: string,
  ) {
    // We use a transaction to guarantee the outbox event and the history record are atomic
    await this.prisma.$transaction(async (tx) => {
      // 1. Write the immutable audit record
      await tx.barcodeHistory.create({
        data: {
          shopId,
          barcodeId,
          oldCode,
          newCode,
          reason,
          changedById: userId,
        },
      });

      // 2. Dispatch to the transactional outbox
      await tx.outboxEvent.create({
        data: {
          type: 'BarcodeChanged',
          shopId: shopId,
          payload: {
            shopId,
            barcodeId,
            oldCode,
            newCode,
            reason,
            userId,
            timestamp: new Date().toISOString(),
          },
          status: 'PENDING',
        },
      });
    });
  }

  /**
   * Retrieves the immutable history of a specific barcode entity.
   */
  async getBarcodeHistory(shopId: string, barcodeId: string, query?: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const where = { shopId, barcodeId };
    const [items, total] = await Promise.all([
      this.prisma.barcodeHistory.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { changedBy: { select: { id: true, name: true, email: true } } },
        skip,
        take,
      }),
      this.prisma.barcodeHistory.count({ where }),
    ]);
    return { items, total, skip, take };
  }
}

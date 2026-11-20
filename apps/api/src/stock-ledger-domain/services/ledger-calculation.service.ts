import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LedgerCalculationService {
  private readonly logger = new Logger(LedgerCalculationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mathematically derives the exact balance of an item by combining 
   * the most recent snapshot + all subsequent ledger entries.
   * This guarantees absolute precision without scanning the entire history.
   */
  async calculateBalanceAt(shopId: string, inventoryItemId: string, pointInTime: Date = new Date()): Promise<number> {
    // 1. Find the latest snapshot BEFORE the point in time
    const latestSnapshot = await this.prisma.stockSnapshot.findFirst({
      where: { 
        shopId, 
        inventoryItemId, 
        periodEnd: { lte: pointInTime } 
      },
      orderBy: { periodEnd: 'desc' }
    });

    const balance = latestSnapshot ? latestSnapshot.closingBalance.toNumber() : 0;
    const sinceDate = latestSnapshot ? latestSnapshot.periodEnd : new Date(0); // Epoch if no snapshot

    // 2. Sum all ledger entries strictly AFTER the snapshot and BEFORE the point in time
    const result = await this.prisma.stockLedgerEntry.aggregate({
      _sum: {
        quantity: true
      },
      where: {
        shopId,
        inventoryItemId,
        createdAt: {
          gt: sinceDate,
          lte: pointInTime
        }
      }
    });

    const delta = result._sum.quantity ? result._sum.quantity.toNumber() : 0;
    
    return balance + delta;
  }
}

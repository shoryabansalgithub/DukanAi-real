import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerCalculationService } from './ledger-calculation.service';

export interface IntegrityReport {
  intact: boolean;
  ledgerBalance: number;
  cachedBalance: number;
}

@Injectable()
export class LedgerIntegrityService {
  private readonly logger = new Logger(LedgerIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: LedgerCalculationService,
  ) {}

  /** The live inventory item of the shop, or 404 `INVENTORY_ITEM_NOT_FOUND` (an unknown id is a client error, never a 500). */
  async requireItem(shopId: string, inventoryItemId: string) {
    const item = await this.prisma.inventoryItem.findFirst({ where: { id: inventoryItemId, shopId, isDeleted: false } });
    if (!item) throw new NotFoundException({ message: `Inventory item ${inventoryItemId} not found`, code: 'INVENTORY_ITEM_NOT_FOUND' });
    return item;
  }

  /**
   * Compares the ledger's computed balance with the cached `InventoryItem.onHand`.
   * A mismatch is reported (and logged as an error for the operator), not thrown:
   * the route is a diagnostic read, and the figures are what the operator needs.
   */
  async verifyIntegrity(shopId: string, inventoryItemId: string): Promise<IntegrityReport> {
    const item = await this.requireItem(shopId, inventoryItemId);
    const ledgerBalance = await this.calculator.calculateBalanceAt(shopId, inventoryItemId);
    const cachedBalance = item.onHand.toNumber();
    const intact = ledgerBalance === cachedBalance;
    if (!intact) {
      this.logger.error(`Ledger integrity violation for inventory item ${inventoryItemId} of shop ${shopId}: ledger ${ledgerBalance}, cached ${cachedBalance}`);
    }
    return { intact, ledgerBalance, cachedBalance };
  }
}

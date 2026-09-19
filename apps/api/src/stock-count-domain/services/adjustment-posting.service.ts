import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdjustmentStatus, LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';

@Injectable()
export class AdjustmentPostingService {
  private readonly logger = new Logger(AdjustmentPostingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly ledger: LedgerPostingService,
  ) {}

  /**
   * Securely posts an approved adjustment to the Stock Ledger.
   * This is the ONLY legitimate way to bypass standard transactional flows and edit stock.
   *
   * The stock value moved (|delta| × Product.costPrice, read inside the
   * transaction) is posted through `LedgerPostingService`:
   *   positive delta: DEBIT INVENTORY / CREDIT INVENTORY_ADJUSTMENT
   *   negative delta: DEBIT INVENTORY_ADJUSTMENT / CREDIT INVENTORY
   * Adjustments the engine bypasses (SERVICE / DIGITAL products) post nothing.
   */
  async postApprovedAdjustment(shopId: string, adjustmentId: string, postedByUserId: string) {
    const adjustment = await this.prisma.adjustmentRequest.findFirst({
      where: { id: adjustmentId, shopId, status: AdjustmentStatus.APPROVED },
      include: { inventoryItem: true }
    });

    if (!adjustment) throw new BadRequestException('Adjustment request not found or not approved.');

    return this.prisma.$transaction(async (tx) => {
      const delta = new Prisma.Decimal(adjustment.requestedQuantityDelta.toString());
      const absDelta = delta.abs();

      // 1. Delegate to Engine for safe ledger entry and dual-write caches
      const result = await this.inventoryMutationEngine.mutateStock(tx, {
        shopId,
        locationId: adjustment.inventoryItem.locationId,
        productId: adjustment.inventoryItem.productId,
        quantity: absDelta.toNumber(),
        mutationType: MutationType.ADJUSTMENT,
        metadata: { direction: delta.isNegative() ? -1 : 1 },
        reason: `Adjustment Request: ${adjustment.id}`,
        referenceId: adjustment.id,
        performedBy: postedByUserId,
        occurredAt: new Date(),
        allowNegative: adjustment.inventoryItem.isNegativeAllowed
      });

      // 2. Post the stock value through the double-entry authority
      if (!result.bypassed) {
        await this.postAdjustmentValue(tx, shopId, adjustment.id, adjustment.inventoryItem.productId, delta);
      }

      // 3. Mark Adjustment as Posted
      await tx.adjustmentRequest.update({
        where: { id: adjustment.id },
        data: { 
          status: AdjustmentStatus.POSTED
        }
      });

      this.logger.log(`Posted Adjustment ${adjustment.id}.`);
      
      return { success: true };
    });
  }

  private async postAdjustmentValue(tx: Prisma.TransactionClient, shopId: string, adjustmentId: string, productId: string, delta: Prisma.Decimal) {
    if (delta.isZero()) return;

    const product = await tx.product.findUnique({ where: { id: productId }, select: { costPrice: true } });
    const costPrice = new Prisma.Decimal((product?.costPrice ?? 0).toString());
    const value = delta.abs().times(costPrice).toDecimalPlaces(2);
    if (value.lessThanOrEqualTo(0)) return;

    const description = `Stock adjustment ${adjustmentId}`;
    const existing = await tx.ledgerTransaction.findFirst({ where: { shopId, description }, select: { id: true } });
    if (existing) {
      this.logger.log(`Ledger posting for ${description} already exists. Skipping.`);
      return;
    }

    const gain = delta.greaterThan(0);
    await this.ledger.post(tx, {
      shopId,
      invoiceId: null,
      description,
      entries: [
        { account: LedgerAccount.INVENTORY, type: gain ? LedgerEntryType.DEBIT : LedgerEntryType.CREDIT, amount: value },
        { account: LedgerAccount.INVENTORY_ADJUSTMENT, type: gain ? LedgerEntryType.CREDIT : LedgerEntryType.DEBIT, amount: value },
      ],
    });
  }
}

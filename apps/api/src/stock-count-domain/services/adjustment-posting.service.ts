import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdjustmentStatus, LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';
import { countVariance } from './count-expectation';

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
  async postApprovedAdjustment(shopId: string, adjustmentId: string, postedByUserId: string, outerTx?: Prisma.TransactionClient) {
    const run = async (tx: Prisma.TransactionClient) => {
      // Claim the request first (APPROVED -> POSTED, status-guarded): a
      // concurrent poster finds no row and stops before touching stock. If the
      // stock or ledger write below fails, the transaction rolls the claim back.
      const claimed = await tx.adjustmentRequest.updateMany({
        where: { id: adjustmentId, shopId, status: AdjustmentStatus.APPROVED },
        data: { status: AdjustmentStatus.POSTED },
      });
      if (claimed.count === 0) throw new BadRequestException({ message: 'Adjustment request not found, not approved, or already posted.', code: 'ADJUSTMENT_NOT_APPROVED' });
      const adjustment = await tx.adjustmentRequest.findFirstOrThrow({ where: { id: adjustmentId, shopId }, include: { inventoryItem: true } });

      let delta = new Prisma.Decimal(adjustment.requestedQuantityDelta.toString());
      if (adjustment.countItemId) {
        // A count's adjustment posts counted − (snapshot + movements up to the count), recomputed
        // under the product lock (release audit S1): a sale that committed after the variance was
        // recorded but happened before the count is part of the expectation, never posted twice.
        await this.inventoryMutationEngine.lockProducts(tx, shopId, [adjustment.inventoryItem.productId]);
        const countItem = await tx.stockCountItem.findFirst({ where: { id: adjustment.countItemId, shopId }, include: { session: { select: { startedAt: true, createdAt: true } } } });
        const recomputed = countItem ? await countVariance(tx, countItem, countItem.session) : null;
        if (recomputed && !recomputed.equals(delta)) {
          this.logger.log(`Adjustment ${adjustment.id}: variance at the count is ${recomputed.toString()} (requested ${delta.toString()}).`);
          delta = recomputed;
          await tx.adjustmentRequest.update({ where: { id: adjustment.id }, data: { requestedQuantityDelta: delta } });
        }
        if (delta.isZero()) {
          this.logger.log(`Adjustment ${adjustment.id} posts nothing: the count matches the stock at the time of counting.`);
          return { success: true, delta: '0' };
        }
      }
      const absDelta = delta.abs();

      // 1. Delegate to Engine for safe ledger entry and dual-write caches
      const result = await this.inventoryMutationEngine.mutateStock(tx, {
        shopId,
        locationId: adjustment.inventoryItem.locationId,
        productId: adjustment.inventoryItem.productId,
        variantId: adjustment.inventoryItem.variantId,
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

      this.logger.log(`Posted Adjustment ${adjustment.id}.`);

      return { success: true, delta: delta.toString() };
    };
    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }

  private async postAdjustmentValue(tx: Prisma.TransactionClient, shopId: string, adjustmentId: string, productId: string, delta: Prisma.Decimal) {
    if (delta.isZero()) return;

    const product = await tx.product.findUnique({ where: { id: productId }, select: { costPrice: true } });
    const costPrice = new Prisma.Decimal((product?.costPrice ?? 0).toString());
    const value = delta.abs().times(costPrice).toDecimalPlaces(2);
    if (value.lessThanOrEqualTo(0)) return;

    const description = `Stock adjustment ${adjustmentId}`;

    const gain = delta.greaterThan(0);
    // Idempotent at the database level: LedgerPosting (shopId, sourceType, sourceId) is unique.
    const result = await this.ledger.post(tx, {
      shopId,
      source: { type: 'ADJUSTMENT_REQUEST', id: adjustmentId },
      invoiceId: null,
      description,
      entries: [
        { account: LedgerAccount.INVENTORY, type: gain ? LedgerEntryType.DEBIT : LedgerEntryType.CREDIT, amount: value },
        { account: LedgerAccount.INVENTORY_ADJUSTMENT, type: gain ? LedgerEntryType.CREDIT : LedgerEntryType.DEBIT, amount: value },
      ],
    });
    if (!result.posted) this.logger.log(`Ledger posting for ${description} already exists. Skipped.`);
  }
}

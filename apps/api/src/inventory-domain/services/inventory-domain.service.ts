import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { AdjustmentReason, LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';
import { ProductEventPublisher } from '../../product-events/services/product-event-publisher.service';
import { InventoryFeatureConfig } from '../../config/domains/features/inventory-feature.config';
import { InventoryMutationEngine, MutationType } from './inventory-mutation.engine';
import { OptimisticLockConflictError, InsufficientStockError } from '../errors/inventory.errors';
import { InventoryLocationService } from './inventory-location.service';
import { InventoryCacheService } from '../../inventory/inventory-cache.service';

@Injectable()
export class InventoryDomainService {
  private readonly logger = new Logger(InventoryDomainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly eventPublisher: ProductEventPublisher,
    private readonly inventoryFeatureConfig: InventoryFeatureConfig,
    private readonly inventoryMutationEngine: InventoryMutationEngine,
    private readonly locationService: InventoryLocationService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly ledger: LedgerPostingService,
  ) {}

  async ensureInventoryItem(productId: string, variantId?: string, explicitLocationId?: string) {
    const shopId = this.tenantContext.getShopId();

    // 1. Resolve Location: explicit ids must belong to this shop; otherwise use the sale location.
    let locationId: string;
    if (explicitLocationId) {
      const valid = await this.locationService.isValidLocation(this.prisma, shopId, explicitLocationId);
      if (!valid) throw new BadRequestException({ message: 'Location does not belong to this shop', code: 'LOCATION_INVALID' });
      locationId = explicitLocationId;
    } else {
      locationId = await this.locationService.resolveSaleLocation(this.prisma, shopId);
    }

    const existing = await this.prisma.inventoryItem.findFirst({ where: { shopId, productId, variantId: variantId || null, locationId, isDeleted: false } });
    if (existing) return existing;

    // Same authority as every stock mutation: Product row lock, unique-index
    // guard and the legacy `Product.currentStock` bootstrap, so the row this
    // creates is the row the POS sells from with the stock it already had.
    const created = await this.prisma.$transaction(
      (tx) => this.inventoryMutationEngine.ensureInventoryItem(tx, { shopId, productId, locationId, variantId: variantId || null, performedBy: this.tenantContext.getUserId() }),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.prisma.inventoryItem.findUniqueOrThrow({ where: { id: created.id } });
  }

  /** The shop's POS sale location (default warehouse, default bin). */
  async getSaleLocationId(): Promise<string> {
    return this.locationService.resolveSaleLocation(this.prisma, this.tenantContext.getShopId());
  }

  /**
   * Retrieves all inventory items for the current shop.
   */
  async findAll() {
    const shopId = this.tenantContext.getShopId();
    return this.prisma.inventoryItem.findMany({
      where: { shopId, isDeleted: false },
      include: { product: { select: { id: true, name: true, sku: true, imageUrl: true, unit: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Retrieves a single inventory item with recent movements.
   */
  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id, shopId, isDeleted: false },
      include: {
        product: { select: { id: true, name: true, sku: true, imageUrl: true, unit: true } },
        adjustments: { take: this.inventoryFeatureConfig.recentAdjustmentsLimit, orderBy: { createdAt: 'desc' } },
        movements: { take: this.inventoryFeatureConfig.recentMovementsLimit, orderBy: { createdAt: 'desc' } },
        alerts: { where: { isResolved: false }, take: this.inventoryFeatureConfig.unresolvedAlertsLimit },
      },
    });
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  /**
   * Adjusts stock with full transactional safety, optimistic locking, 
   * audit trail, and Outbox event emission.
   */
  async adjustStock(
    inventoryItemId: string,
    reason: AdjustmentReason,
    quantityChange: number,
    createdBy: string,
    opts?: { notes?: string; correlationId?: string }
  ) {
    const shopId = this.tenantContext.getShopId();

    if (!Number.isFinite(quantityChange) || quantityChange === 0) {
      throw new BadRequestException({ message: 'quantityChange must be a non-zero number', code: 'INVALID_QUANTITY' });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Fetch item to get ProductId
      const item = await tx.inventoryItem.findFirst({
        where: { id: inventoryItemId, shopId, isDeleted: false },
      });

      if (!item) throw new NotFoundException('Inventory item not found');

      // 2. Delegate to Engine
      const isDeduction = quantityChange < 0;
      let mutationType = MutationType.ADJUSTMENT;
      if (isDeduction && reason === AdjustmentReason.DAMAGE) mutationType = MutationType.DAMAGE;
      if (isDeduction && reason === AdjustmentReason.EXPIRY) mutationType = MutationType.EXPIRED;
      if (isDeduction && reason === AdjustmentReason.LOSS) mutationType = MutationType.LOSS;
      if (!isDeduction && reason === AdjustmentReason.OPENING_BALANCE) mutationType = MutationType.OPENING;

      let engineResult;
      try {
        engineResult = await this.inventoryMutationEngine.mutateStock(tx, {
          shopId,
          locationId: item.locationId,
          productId: item.productId,
          quantity: Math.abs(quantityChange),
          mutationType,
          metadata: { direction: isDeduction ? -1 : 1 },
          reason: opts?.notes ? `${reason} - ${opts.notes}` : reason,
          referenceId: opts?.correlationId || `ADJ-${new Date().getTime()}`,
          performedBy: createdBy,
          occurredAt: new Date(),
          allowNegative: item.isNegativeAllowed,
        });
      } catch (e: any) {
        if (e instanceof OptimisticLockConflictError) {
          throw new ConflictException('Concurrent modification detected. Please retry.');
        }
        if (e instanceof InsufficientStockError) {
          throw new BadRequestException(
            `Insufficient stock. Requested deduction: ${Math.abs(quantityChange)}`
          );
        }
        throw e;
      }

      // Authoritative values come from the engine (post-update row), never from the pre-lock read.
      const newOnHand = engineResult.balanceAfter.toNumber();
      const oldOnHand = engineResult.balanceAfter.minus(isDeduction ? -Math.abs(quantityChange) : Math.abs(quantityChange)).toNumber();

      // Accounting effect of a manual adjustment: stock value moves between
      // INVENTORY (asset) and INVENTORY_ADJUSTMENT (expense) at cost price.
      if (!engineResult.bypassed) {
        const product = await tx.product.findUnique({ where: { id: item.productId }, select: { costPrice: true } });
        const value = new Prisma.Decimal(product?.costPrice ?? 0).mul(Math.abs(quantityChange)).toDecimalPlaces(2);
        if (value.greaterThan(0)) {
          await this.ledger.post(tx, {
            shopId,
            description: `Stock adjustment ${inventoryItemId} (${reason})`,
            entries: isDeduction
              ? [
                  { account: LedgerAccount.INVENTORY_ADJUSTMENT, type: LedgerEntryType.DEBIT, amount: value },
                  { account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: value },
                ]
              : [
                  { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: value },
                  { account: LedgerAccount.INVENTORY_ADJUSTMENT, type: LedgerEntryType.CREDIT, amount: value },
                ],
          });
        }
      }

      await tx.inventoryAdjustment.create({
        data: {
          shopId,
          inventoryItemId,
          reason,
          quantityBefore: oldOnHand,
          quantityChange: quantityChange,
          quantityAfter: newOnHand,
          createdBy,
          notes: opts?.notes,
          correlationId: opts?.correlationId,
        },
      });

      // 7. Emit event to Outbox
      await this.eventPublisher.publish(tx as any, {
        shopId,
        eventType: 'InventoryAdjusted',
        entityId: inventoryItemId,
        entityType: 'InventoryItem',
        payload: {
          inventoryItemId,
          productId: item.productId,
          reason,
          quantityBefore: oldOnHand,
          quantityChange,
          quantityAfter: newOnHand,
        },
      });

      // 8. Check thresholds and generate alerts
      if (newOnHand <= item.reorderPoint.toNumber()) {
        await tx.inventoryAlert.create({
          data: {
            shopId,
            inventoryItemId,
            alertType: 'LOW_STOCK',
            message: `Stock for item ${inventoryItemId} is below reorder point (${item.reorderPoint})`,
            currentValue: newOnHand,
            thresholdValue: item.reorderPoint,
          },
        });
      }

      if (newOnHand < 0) {
        await tx.inventoryAlert.create({
          data: {
            shopId,
            inventoryItemId,
            alertType: 'NEGATIVE_STOCK',
            message: `Negative stock detected for item ${inventoryItemId}: ${newOnHand}`,
            currentValue: newOnHand,
          },
        });
      }

      // 9. Audit trail for the operator action
      await tx.auditLog.create({
        data: {
          shopId,
          userId: createdBy,
          action: 'STOCK_ADJUSTED',
          entity: 'InventoryItem',
          entityId: inventoryItemId,
          beforeData: { onHand: oldOnHand },
          afterData: { onHand: newOnHand, quantityChange, reason, notes: opts?.notes ?? null, productId: item.productId },
        },
      });

      this.logger.log(`Stock adjusted: ${inventoryItemId} ${oldOnHand} → ${newOnHand} (${reason})`);

      return {
        inventoryItemId,
        productId: item.productId,
        quantityBefore: oldOnHand,
        quantityChange,
        quantityAfter: newOnHand,
        productStockAfter: engineResult.productStockAfter.toNumber(),
        reason,
      };
    });

    // Keep the Redis fast-path in step with the authoritative aggregate.
    await this.inventoryCache.syncStock(result.productId, result.productStockAfter);
    return result;
  }

  /**
   * Get adjustment history for an inventory item.
   */
  async getAdjustmentHistory(inventoryItemId: string) {
    const shopId = this.tenantContext.getShopId();
    return this.prisma.inventoryAdjustment.findMany({
      where: { inventoryItemId, shopId },
      orderBy: { createdAt: 'desc' },
      take: this.inventoryFeatureConfig.inventoryListLimit,
    });
  }

  /**
   * Get active alerts for the shop.
   */
  async getAlerts() {
    const shopId = this.tenantContext.getShopId();
    return this.prisma.inventoryAlert.findMany({
      where: { shopId, isResolved: false },
      include: {
        inventoryItem: {
          include: { product: { select: { id: true, name: true, sku: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Inventory health check — counts anomalies.
   */
  async getHealth() {
    const shopId = this.tenantContext.getShopId();

    const [totalItems, negativeItems, lowStockItems, activeAlerts] = await Promise.all([
      this.prisma.inventoryItem.count({ where: { shopId, isDeleted: false } }),
      this.prisma.inventoryItem.count({ where: { shopId, isDeleted: false, onHand: { lt: 0 } } }),
      this.prisma.inventoryItem.count({
        where: {
          shopId,
          isDeleted: false,
          // Prisma doesn't support comparing two fields directly, so we fetch and filter
        },
      }),
      this.prisma.inventoryAlert.count({ where: { shopId, isResolved: false } }),
    ]);

    return {
      totalItems,
      negativeItems,
      lowStockItems,
      activeAlerts,
      healthScore: negativeItems === 0 ? 100 : Math.max(0, 100 - (negativeItems * 10)),
    };
  }
}

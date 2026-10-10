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
import { assertOwned } from '../../prisma/tenant-ownership';
import { ListQueryDto, pageArgs } from '../../common/pagination';

/** The key of an item's one opening-stock movement (stock ledger `correlationId` and `referenceId`). */
export function openingStockKey(inventoryItemId: string): string {
  return `OPENING:${inventoryItemId}`;
}

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
    await assertOwned(this.prisma, 'product', productId, shopId, { isDeleted: false });
    await assertOwned(this.prisma, 'productVariant', variantId, shopId);

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
  async findAll(query?: ListQueryDto) {
    const shopId = this.tenantContext.getShopId();
    const { skip, take } = pageArgs(query);
    const where = { shopId, isDeleted: false };
    const [items, total] = await Promise.all([
      this.prisma.inventoryItem.findMany({
        where,
        include: { product: { select: { id: true, name: true, sku: true, imageUrl: true, unit: true } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.inventoryItem.count({ where }),
    ]);
    return { items, total, skip, take };
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
      return this.applyAdjustment(tx, shopId, item, reason, quantityChange, createdBy, opts);
    });

    // Keep the Redis fast-path in step with the authoritative aggregate.
    await this.inventoryCache.syncStock(result.productId, result.productStockAfter);
    return result;
  }

  /**
   * The opening stock of a product (roadmap 9.20): the counted quantity on
   * the shelf on day one, recorded as the first movement of its product-level
   * item at the sale location (`OPENING_BALANCE`, valued at cost against
   * OPENING_BALANCE_EQUITY). Once per item: the movement is keyed
   * (`OPENING:<itemId>`), so the same quantity again is `UNCHANGED` and
   * another quantity is 409 `OPENING_STOCK_EXISTS`; an item that already
   * moved (a sale, a receipt, a legacy `currentStock` bootstrap) is 409
   * `OPENING_STOCK_AFTER_MOVEMENTS`: the difference is a stock adjustment.
   */
  async recordOpeningStock(input: { productId: string; quantity: number; createdBy: string; notes?: string }): Promise<{ status: 'CREATED' | 'UNCHANGED'; inventoryItemId: string; quantityAfter: number }> {
    const shopId = this.tenantContext.getShopId();
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException({ message: 'Opening stock must be more than 0.', code: 'INVALID_QUANTITY' });
    }
    const item = await this.ensureInventoryItem(input.productId);
    const key = openingStockKey(item.id);
    const quantity = new Prisma.Decimal(input.quantity);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Same lock as every stock mutation of the product, before reading its movements.
      await this.inventoryMutationEngine.lockProducts(tx, shopId, [input.productId]);
      const current = await tx.inventoryItem.findFirstOrThrow({ where: { id: item.id, shopId } });
      const opening = await tx.stockLedgerEntry.findFirst({ where: { shopId, inventoryItemId: item.id, correlationId: key }, select: { quantity: true } });
      if (opening) {
        if (opening.quantity.equals(quantity)) return { status: 'UNCHANGED' as const, quantityAfter: current.onHand.toNumber(), productStockAfter: null };
        throw new ConflictException({
          message: `The opening stock of this product is already recorded as ${opening.quantity.toString()}; record the difference as a stock adjustment.`,
          code: 'OPENING_STOCK_EXISTS',
          details: { recorded: opening.quantity.toString(), requested: quantity.toString() },
        });
      }
      const movements = await tx.stockLedgerEntry.count({ where: { shopId, inventoryItemId: item.id } });
      if (movements > 0) {
        throw new ConflictException({
          message: `This product already has stock movements (${current.onHand.toString()} on hand); record the difference as a stock adjustment.`,
          code: 'OPENING_STOCK_AFTER_MOVEMENTS',
          details: { onHand: current.onHand.toString(), movements },
        });
      }
      const result = await this.applyAdjustment(tx, shopId, current, AdjustmentReason.OPENING_BALANCE, input.quantity, input.createdBy, {
        notes: input.notes,
        idempotencyKey: key,
        referenceId: key,
      });
      return { status: 'CREATED' as const, quantityAfter: result.quantityAfter, productStockAfter: result.productStockAfter };
    });

    if (outcome.productStockAfter !== null) await this.inventoryCache.syncStock(input.productId, outcome.productStockAfter);
    return { status: outcome.status, inventoryItemId: item.id, quantityAfter: outcome.quantityAfter };
  }

  /**
   * One adjustment of an item inside the caller's transaction: the engine
   * mutation, the InventoryAdjustment row, the ledger posting at cost, the
   * outbox event, threshold alerts and the audit row. A keyed movement that
   * is already in the stock ledger (`opts.idempotencyKey`) writes nothing
   * and comes back `idempotent`.
   */
  private async applyAdjustment(
    tx: Prisma.TransactionClient,
    shopId: string,
    item: { id: string; productId: string; locationId: string; variantId: string | null; isNegativeAllowed: boolean; reorderPoint: Prisma.Decimal },
    reason: AdjustmentReason,
    quantityChange: number,
    createdBy: string,
    opts?: { notes?: string; correlationId?: string; idempotencyKey?: string; referenceId?: string },
  ) {
    const inventoryItemId = item.id;
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
        // The row the caller named: a variant's item, not the product-level row (roadmap 3.7, audit P2-27).
        variantId: item.variantId,
        quantity: Math.abs(quantityChange),
        mutationType,
        metadata: { direction: isDeduction ? -1 : 1 },
        reason: opts?.notes ? `${reason} - ${opts.notes}` : reason,
        referenceId: opts?.referenceId ?? (opts?.correlationId || `ADJ-${new Date().getTime()}`),
        idempotencyKey: opts?.idempotencyKey,
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

    if (engineResult.idempotent) {
      // The keyed movement is already in the stock ledger: nothing new is written (roadmap 9.20 re-runs).
      const after = engineResult.balanceAfter.toNumber();
      return {
        inventoryItemId,
        productId: item.productId,
        quantityBefore: after - quantityChange,
        quantityChange,
        quantityAfter: after,
        productStockAfter: engineResult.productStockAfter.toNumber(),
        reason,
        idempotent: true,
      };
    }

    // Authoritative values come from the engine (post-update row), never from the pre-lock read.
    const newOnHand = engineResult.balanceAfter.toNumber();
    const oldOnHand = engineResult.balanceAfter.minus(isDeduction ? -Math.abs(quantityChange) : Math.abs(quantityChange)).toNumber();

    const adjustment = await tx.inventoryAdjustment.create({
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

    // Accounting effect: stock value moves between INVENTORY (asset) and the
    // contra at cost price: INVENTORY_ADJUSTMENT (expense) for counts, damage,
    // loss and expiry; OPENING_BALANCE_EQUITY for opening stock, which is the
    // shop's capital on day one, not a gain (roadmap 9.20).
    if (!engineResult.bypassed) {
      const product = await tx.product.findUnique({ where: { id: item.productId }, select: { costPrice: true } });
      const value = new Prisma.Decimal(product?.costPrice ?? 0).mul(Math.abs(quantityChange)).toDecimalPlaces(2);
      const contra = reason === AdjustmentReason.OPENING_BALANCE ? LedgerAccount.OPENING_BALANCE_EQUITY : LedgerAccount.INVENTORY_ADJUSTMENT;
      if (value.greaterThan(0)) {
        await this.ledger.post(tx, {
          shopId,
          source: { type: 'STOCK_ADJUSTMENT', id: adjustment.id },
          description: `Stock adjustment ${inventoryItemId} (${reason})`,
          entries: isDeduction
            ? [
                { account: contra, type: LedgerEntryType.DEBIT, amount: value },
                { account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT, amount: value },
              ]
            : [
                { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: value },
                { account: contra, type: LedgerEntryType.CREDIT, amount: value },
              ],
        });
      }
    }


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
      idempotent: false,
    };
  }

  /**
   * Get adjustment history for an inventory item.
   */
  async getAdjustmentHistory(inventoryItemId: string) {
    const shopId = this.tenantContext.getShopId();
    // An unknown or foreign item is 404, not an empty list (phase 4 gate: ids answer like every other route).
    await assertOwned(this.prisma, 'inventoryItem', inventoryItemId, shopId, { isDeleted: false });
    return this.prisma.inventoryAdjustment.findMany({
      where: { inventoryItemId, shopId },
      orderBy: { createdAt: 'desc' },
      take: this.inventoryFeatureConfig.inventoryListLimit,
    });
  }

  /**
   * Get active alerts for the shop.
   */
  async getAlerts(query?: ListQueryDto) {
    const shopId = this.tenantContext.getShopId();
    const { skip, take } = pageArgs(query);
    const where = { shopId, isResolved: false };
    const [items, total] = await Promise.all([
      this.prisma.inventoryAlert.findMany({
        where,
        include: {
          inventoryItem: {
            include: { product: { select: { id: true, name: true, sku: true } } },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.inventoryAlert.count({ where }),
    ]);
    return { items, total, skip, take };
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

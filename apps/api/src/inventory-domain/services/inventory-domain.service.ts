import { Injectable, Logger, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { AdjustmentReason, LedgerAccount, LedgerEntryType, Prisma, Role } from '@prisma/client';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';
import { ProductEventPublisher } from '../../product-events/services/product-event-publisher.service';
import { InventoryFeatureConfig } from '../../config/domains/features/inventory-feature.config';
import { InventoryMutationEngine, MutationType } from './inventory-mutation.engine';
import { OptimisticLockConflictError, InsufficientStockError } from '../errors/inventory.errors';
import { InventoryLocationService } from './inventory-location.service';
import { InventoryCacheService } from '../../inventory/inventory-cache.service';
import { assertOwned } from '../../prisma/tenant-ownership';
import { ListQueryDto, pageArgs } from '../../common/pagination';
import { withSerializationRetry } from '../../common/db/serialization-retry';
import { ADMIN_ROLES } from '../../auth/role-sets';

/** Largest |quantity| one stock movement may carry: InventoryItem.onHand is Decimal(12, 3). */
export const MAX_STOCK_QUANTITY = 999_999_999.999;

/** The actor of a direct adjustment; a MANAGER is capped by INVENTORY_MANAGER_MAX_ADJUST_VALUE (release audit T5). */
export interface AdjustmentActor {
  id: string;
  role?: Role | null;
}

export interface TransferInput {
  productId: string;
  variantId?: string | null;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  idempotencyKey: string;
  notes?: string;
}

/** A variant named next to a product must be one of that product's (release audit T6e). */
export async function assertVariantOfProduct(db: Prisma.TransactionClient | PrismaService, shopId: string, productId: string, variantId: string | null | undefined): Promise<void> {
  if (!variantId) return;
  const variant = await db.productVariant.findFirst({ where: { id: variantId, shopId, productId }, select: { id: true } });
  if (!variant) throw new NotFoundException({ message: `Product variant ${variantId} not found for this product.`, code: 'VARIANT_NOT_FOUND' });
}

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
    await assertVariantOfProduct(this.prisma, shopId, productId, variantId);

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
   * audit trail, and Outbox event emission (POST /inventory-domain/:id/adjust).
   *
   * Release audit S18 / T5:
   *  - the quantity is bounded by the column (Decimal(12, 3)) and never 0;
   *  - an `idempotencyKey` makes a retried request a replay (the engine skips
   *    a movement whose key is already in the stock ledger); the same key for
   *    another item or quantity is 409 IDEMPOTENCY_KEY_REUSED;
   *  - `OPENING_BALANCE` is positive and once per item (409 OPENING_STOCK_EXISTS);
   *  - a MANAGER adjusts directly only up to INVENTORY_MANAGER_MAX_ADJUST_VALUE
   *    of stock value (|quantity| × cost price); more is 403
   *    ADJUSTMENT_REQUIRES_APPROVAL (a stock-count adjustment request, which
   *    another manager approves). OWNER / ADMIN are not capped.
   */
  async adjustStock(
    inventoryItemId: string,
    reason: AdjustmentReason,
    quantityChange: number,
    createdBy: string | AdjustmentActor,
    opts?: { notes?: string; correlationId?: string; idempotencyKey?: string }
  ) {
    const shopId = this.tenantContext.getShopId();
    const actor: AdjustmentActor = typeof createdBy === 'string' ? { id: createdBy } : createdBy;

    if (!Number.isFinite(quantityChange) || quantityChange === 0 || Math.abs(quantityChange) > MAX_STOCK_QUANTITY) {
      throw new BadRequestException({ message: `quantityChange must be a non-zero number of at most ${MAX_STOCK_QUANTITY} in size`, code: 'INVALID_QUANTITY' });
    }
    if (reason === AdjustmentReason.OPENING_BALANCE && quantityChange < 0) {
      throw new BadRequestException({ message: 'Opening stock cannot be negative; record a correction instead.', code: 'OPENING_STOCK_NEGATIVE' });
    }
    const key = opts?.idempotencyKey ? `ADJ:${opts.idempotencyKey}` : undefined;

    const result = await withSerializationRetry(() =>
      this.prisma.$transaction(async (tx) => {
        // 1. Fetch item to get ProductId
        const item = await tx.inventoryItem.findFirst({
          where: { id: inventoryItemId, shopId, isDeleted: false },
        });

        if (!item) throw new NotFoundException({ message: 'Inventory item not found', code: 'INVENTORY_ITEM_NOT_FOUND' });
        // Every check below reads under the product lock every stock movement takes.
        await this.inventoryMutationEngine.lockProducts(tx, shopId, [item.productId]);

        if (key) {
          const replay = await tx.stockLedgerEntry.findFirst({ where: { shopId, correlationId: key }, select: { inventoryItemId: true, quantity: true } });
          if (replay && (replay.inventoryItemId !== item.id || !replay.quantity.abs().equals(new Prisma.Decimal(Math.abs(quantityChange))))) {
            throw new ConflictException({ message: 'This idempotency key was already used for a different adjustment.', code: 'IDEMPOTENCY_KEY_REUSED' });
          }
        }
        if (reason === AdjustmentReason.OPENING_BALANCE) {
          const opening = await tx.inventoryAdjustment.findFirst({ where: { shopId, inventoryItemId: item.id, reason: AdjustmentReason.OPENING_BALANCE }, select: { id: true, quantityChange: true } });
          const imported = await tx.stockLedgerEntry.findFirst({ where: { shopId, inventoryItemId: item.id, correlationId: openingStockKey(item.id) }, select: { id: true } });
          const isReplay = key ? await tx.stockLedgerEntry.findFirst({ where: { shopId, correlationId: key }, select: { id: true } }) : null;
          if ((opening || imported) && !isReplay) {
            throw new ConflictException({ message: 'The opening stock of this item is already recorded; record the difference as a correction.', code: 'OPENING_STOCK_EXISTS' });
          }
        }
        if (actor.role && !ADMIN_ROLES.includes(actor.role)) {
          const product = await tx.product.findFirst({ where: { id: item.productId, shopId }, select: { costPrice: true } });
          const value = new Prisma.Decimal(product?.costPrice ?? 0).times(Math.abs(quantityChange)).toDecimalPlaces(2);
          const cap = new Prisma.Decimal(this.inventoryFeatureConfig.managerMaxAdjustValue);
          if (value.greaterThan(cap)) {
            throw new ForbiddenException({
              message: `This adjustment moves ₹${value.toFixed(2)} of stock, more than a manager may adjust directly (₹${cap.toFixed(2)}). Ask an owner or raise a stock-count adjustment for approval.`,
              code: 'ADJUSTMENT_REQUIRES_APPROVAL',
              details: { value: value.toFixed(2), limit: cap.toFixed(2) },
            });
          }
        }
        return this.applyAdjustment(tx, shopId, item, reason, quantityChange, actor.id, { ...opts, idempotencyKey: key, referenceId: key });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    );

    // Keep the Redis fast-path in step with the authoritative aggregate.
    await this.inventoryCache.syncStock(result.productId, result.productStockAfter);
    return result;
  }

  /**
   * Moves stock between two locations of the shop (release audit S2: goods
   * received into a back warehouse could never reach the POS, which sells
   * from the sale location). One transaction: the product row locked, a
   * TRANSFER_OUT at the source (refused when the source does not hold the
   * quantity) and a TRANSFER_IN at the destination through the inventory
   * engine. Ledger-neutral: the stock keeps its value, only its place
   * changes, so nothing is posted. `idempotencyKey` makes a retry a replay
   * (both movements are keyed); the same key for another transfer is 409.
   */
  async transferStock(input: TransferInput, actorId: string) {
    const shopId = this.tenantContext.getShopId();
    if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > MAX_STOCK_QUANTITY) {
      throw new BadRequestException({ message: 'A transfer moves a positive quantity.', code: 'INVALID_QUANTITY' });
    }
    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException({ message: 'The source and the destination are the same location.', code: 'TRANSFER_SAME_LOCATION' });
    }
    await assertOwned(this.prisma, 'product', input.productId, shopId, { isDeleted: false });
    const product = await this.prisma.product.findFirst({ where: { id: input.productId, shopId }, select: { type: true } });
    if (product && (product.type === 'SERVICE' || product.type === 'DIGITAL')) {
      throw new BadRequestException({ message: 'A service or digital product holds no stock to move.', code: 'TRANSFER_NOT_STOCKED' });
    }
    await assertVariantOfProduct(this.prisma, shopId, input.productId, input.variantId);
    await assertOwned(this.prisma, 'location', input.fromLocationId, shopId, { isDeleted: false });
    await assertOwned(this.prisma, 'location', input.toLocationId, shopId, { isDeleted: false });

    const referenceId = `TRANSFER:${input.idempotencyKey}`.slice(0, 191);
    const quantity = new Prisma.Decimal(input.quantity);

    const outcome = await withSerializationRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await this.inventoryMutationEngine.lockProducts(tx, shopId, [input.productId]);

        const earlier = await tx.stockLedgerEntry.findMany({ where: { shopId, referenceId }, select: { quantity: true, inventoryItem: { select: { productId: true, variantId: true, locationId: true } } } });
        if (earlier.length > 0) {
          const out = earlier.find((e) => e.quantity.isNegative());
          const into = earlier.find((e) => e.quantity.greaterThan(0));
          const same = out && into
            && out.inventoryItem.productId === input.productId && (out.inventoryItem.variantId ?? null) === (input.variantId ?? null)
            && out.inventoryItem.locationId === input.fromLocationId && into.inventoryItem.locationId === input.toLocationId
            && into.quantity.equals(quantity);
          if (!same) throw new ConflictException({ message: 'This idempotency key was already used for a different transfer.', code: 'IDEMPOTENCY_KEY_REUSED' });
          return { replayed: true, productStockAfter: null as Prisma.Decimal | null };
        }

        const base = {
          shopId,
          productId: input.productId,
          variantId: input.variantId ?? null,
          quantity: input.quantity,
          referenceId,
          performedBy: actorId,
          occurredAt: new Date(),
          reason: input.notes ? `Transfer - ${input.notes}` : 'Transfer',
        };
        try {
          await this.inventoryMutationEngine.mutateStock(tx, { ...base, locationId: input.fromLocationId, mutationType: MutationType.TRANSFER_OUT, idempotencyKey: `${referenceId}:OUT`.slice(0, 191), allowNegative: false });
        } catch (e) {
          if (e instanceof InsufficientStockError) {
            throw new ConflictException({ message: `The source location does not hold ${input.quantity} of this product.`, code: 'INSUFFICIENT_STOCK', details: (e as InsufficientStockError).details });
          }
          throw e;
        }
        const into = await this.inventoryMutationEngine.mutateStock(tx, { ...base, locationId: input.toLocationId, mutationType: MutationType.TRANSFER_IN, idempotencyKey: `${referenceId}:IN`.slice(0, 191) });

        await this.eventPublisher.publish(tx as any, {
          shopId,
          eventType: 'InventoryTransferred',
          entityId: input.productId,
          entityType: 'Product',
          payload: { productId: input.productId, variantId: input.variantId ?? null, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, quantity: input.quantity, referenceId },
        });
        await tx.auditLog.create({
          data: {
            shopId,
            userId: actorId,
            action: 'STOCK_TRANSFERRED',
            entity: 'Product',
            entityId: input.productId,
            afterData: { variantId: input.variantId ?? null, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, quantity: input.quantity, notes: input.notes ?? null },
          },
        });
        return { replayed: false, productStockAfter: into.productStockAfter };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    );

    if (outcome.productStockAfter) await this.inventoryCache.syncStock(input.productId, outcome.productStockAfter.toNumber());
    const items = await this.prisma.inventoryItem.findMany({
      where: { shopId, productId: input.productId, variantKey: input.variantId ?? '-', locationId: { in: [input.fromLocationId, input.toLocationId] }, isDeleted: false },
      select: { id: true, locationId: true, onHand: true },
    });
    const at = (locationId: string) => items.find((i) => i.locationId === locationId)?.onHand.toNumber() ?? 0;
    return {
      status: outcome.replayed ? 'UNCHANGED' : 'TRANSFERRED',
      productId: input.productId,
      variantId: input.variantId ?? null,
      quantity: input.quantity,
      from: { locationId: input.fromLocationId, onHand: at(input.fromLocationId) },
      to: { locationId: input.toLocationId, onHand: at(input.toLocationId) },
    };
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

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StockMovementType, InventoryChangeType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  InsufficientStockError,
  InventoryError,
  InventoryNotFoundError,
  OptimisticLockConflictError,
  TenantViolationError,
} from '../errors/inventory.errors';

export enum MutationType {
  SALE = 'SALE',
  RETURN = 'RETURN',
  PURCHASE = 'PURCHASE',
  PURCHASE_RETURN = 'PURCHASE_RETURN',
  ADJUSTMENT = 'ADJUSTMENT',
  DAMAGE = 'DAMAGE',
  EXPIRED = 'EXPIRED',
  LOSS = 'LOSS',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
  RESERVATION = 'RESERVATION',
  RESERVATION_RELEASE = 'RESERVATION_RELEASE',
  OPENING = 'OPENING',
}

export interface InventoryMutationRequest {
  shopId: string;
  /** Real Location.id. Resolve it with InventoryLocationService; never pass a code. */
  locationId: string;
  productId: string;
  /** Absolute positive quantity. */
  quantity: number;
  mutationType: MutationType;
  reason?: string;
  referenceId: string;
  performedBy: string;
  occurredAt?: Date;
  allowNegative?: boolean;
  metadata?: { direction?: 1 | -1; [key: string]: unknown };
  occ?: {
    expectedProductVersion?: number;
    expectedInventoryItemVersion?: number;
  };
  idempotencyKey?: string;
}

export interface InventoryMutationResult {
  bypassed: boolean;
  idempotent?: boolean;
  reason?: string;
  inventoryItemId?: string;
  locationId?: string;
  /** InventoryItem.onHand after the mutation. */
  balanceAfter: Prisma.Decimal;
  /** onHand - reserved after the mutation. */
  availableAfter: Prisma.Decimal;
  /** Product.currentStock after the mutation (aggregate over locations). */
  productStockAfter: Prisma.Decimal;
}

const MOVEMENT_TYPE: Record<MutationType, (direction: 1 | -1) => StockMovementType> = {
  SALE: () => StockMovementType.SALE,
  RETURN: () => StockMovementType.SALE_RETURN,
  PURCHASE: () => StockMovementType.PURCHASE,
  PURCHASE_RETURN: () => StockMovementType.PURCHASE_RETURN,
  ADJUSTMENT: (d) => (d === -1 ? StockMovementType.ADJUSTMENT_OUT : StockMovementType.ADJUSTMENT_IN),
  DAMAGE: () => StockMovementType.DAMAGE,
  EXPIRED: () => StockMovementType.EXPIRY,
  LOSS: () => StockMovementType.LOSS,
  TRANSFER_OUT: () => StockMovementType.TRANSFER_OUT,
  TRANSFER_IN: () => StockMovementType.TRANSFER_IN,
  RESERVATION: () => StockMovementType.RESERVATION,
  RESERVATION_RELEASE: () => StockMovementType.RESERVATION_RELEASE,
  OPENING: () => StockMovementType.OPENING_BALANCE,
};

const CHANGE_TYPE: Record<MutationType, (direction: 1 | -1) => InventoryChangeType> = {
  SALE: () => InventoryChangeType.SALE,
  RETURN: () => InventoryChangeType.RETURN_IN,
  PURCHASE: () => InventoryChangeType.PURCHASE,
  PURCHASE_RETURN: () => InventoryChangeType.RETURN_OUT,
  ADJUSTMENT: () => InventoryChangeType.ADJUSTMENT,
  DAMAGE: () => InventoryChangeType.DAMAGE,
  EXPIRED: () => InventoryChangeType.DAMAGE,
  LOSS: () => InventoryChangeType.ADJUSTMENT,
  TRANSFER_OUT: () => InventoryChangeType.TRANSFER_OUT,
  TRANSFER_IN: () => InventoryChangeType.TRANSFER_IN,
  RESERVATION: () => InventoryChangeType.ADJUSTMENT,
  RESERVATION_RELEASE: () => InventoryChangeType.ADJUSTMENT,
  OPENING: () => InventoryChangeType.OPENING,
};

/**
 * Single inventory mutation authority.
 *
 * Every stock change (sale, return, purchase, adjustment, transfer,
 * reservation) goes through `mutateStock` inside the caller's transaction.
 * It updates the authoritative `InventoryItem.onHand`, keeps
 * `Product.currentStock` (the aggregate cache) in step, and writes the
 * immutable `StockLedgerEntry`, the `InventoryLog` and a `ProductEventLog`
 * row. Nothing else in the codebase may write these columns.
 */
@Injectable()
export class InventoryMutationEngine {
  private readonly logger = new Logger(InventoryMutationEngine.name);

  private getDirection(request: InventoryMutationRequest): 1 | -1 {
    if (request.metadata?.direction !== undefined) return request.metadata.direction;
    switch (request.mutationType) {
      case MutationType.RETURN:
      case MutationType.PURCHASE:
      case MutationType.TRANSFER_IN:
      case MutationType.RESERVATION_RELEASE:
      case MutationType.OPENING:
        return 1;
      default:
        return -1;
    }
  }

  /**
   * Takes the exclusive Product row locks that every stock mutation runs under,
   * in ascending productId order. Callers that insert rows referencing the
   * product (invoice lines, return lines) call this BEFORE those inserts:
   * a child-row insert takes a shared lock on the parent row, and turning a
   * shared lock into the exclusive one later is a deadlock between two
   * transactions on the same product.
   */
  async lockProducts(tx: Prisma.TransactionClient, shopId: string, productIds: readonly string[]): Promise<void> {
    const ids = Array.from(new Set(productIds)).sort();
    for (const id of ids) {
      const locked = await tx.$queryRaw<Array<{ id: string; shopId: string }>>`
        SELECT id, shopId FROM Product WHERE id = ${id} FOR UPDATE
      `;
      if (locked.length === 0) throw new InventoryNotFoundError(`Product ${id} not found.`);
      if (locked[0].shopId !== shopId) throw new TenantViolationError(`Cross-tenant mutation blocked for product ${id}`);
    }
  }

  async mutateStock(tx: Prisma.TransactionClient, request: InventoryMutationRequest): Promise<InventoryMutationResult> {
    const traceId = uuidv4();

    if (!request.locationId) {
      throw new InventoryError('LOCATION_REQUIRED', 'InventoryMutationEngine: a resolved locationId is required.');
    }
    if (!(request.quantity > 0) || !Number.isFinite(request.quantity)) {
      throw new InventoryError('INVALID_QUANTITY', 'InventoryMutationEngine: quantity must be strictly positive.');
    }

    // 0. Serialise every mutation of this product inside the caller's transaction
    //    (a no-op when the caller already holds the lock, see lockProducts).
    await this.lockProducts(tx, request.shopId, [request.productId]);

    if (request.idempotencyKey) {
      const existingLedger = await tx.stockLedgerEntry.findFirst({
        where: { shopId: request.shopId, referenceId: request.referenceId, correlationId: request.idempotencyKey },
        include: { inventoryItem: { select: { id: true, onHand: true, reserved: true, locationId: true } } },
      });
      if (existingLedger) {
        this.logger.log(`[${traceId}] Idempotency key ${request.idempotencyKey} already processed. Skipping.`);
        const product = await tx.product.findUnique({ where: { id: request.productId }, select: { currentStock: true } });
        return {
          idempotent: true,
          bypassed: false,
          inventoryItemId: existingLedger.inventoryItemId,
          locationId: existingLedger.inventoryItem.locationId,
          balanceAfter: existingLedger.balanceAfter,
          availableAfter: existingLedger.inventoryItem.onHand.minus(existingLedger.inventoryItem.reserved),
          productStockAfter: product?.currentStock ?? new Prisma.Decimal(0),
        };
      }
    }

    const occurredAt = request.occurredAt || new Date();
    const qty = new Prisma.Decimal(request.quantity);

    // 1. Location ownership, product ownership / service bypass
    const location = await tx.location.findFirst({ where: { id: request.locationId, shopId: request.shopId, isDeleted: false }, select: { id: true } });
    if (!location) {
      throw new InventoryError('LOCATION_INVALID', `Location ${request.locationId} does not belong to shop ${request.shopId}.`);
    }
    const product = await tx.product.findUnique({
      where: { id: request.productId },
      select: { shopId: true, type: true, name: true, currentStock: true, stockVersion: true, isDeleted: true },
    });
    if (!product || product.isDeleted) {
      throw new InventoryNotFoundError(`Product ${request.productId} not found.`);
    }
    if (product.shopId !== request.shopId) {
      throw new TenantViolationError(`Cross-tenant mutation blocked for product ${request.productId}`);
    }
    if (product.type === 'SERVICE' || product.type === 'DIGITAL') {
      return {
        bypassed: true,
        reason: 'NON_STOCKED_PRODUCT',
        balanceAfter: new Prisma.Decimal(0),
        availableAfter: new Prisma.Decimal(0),
        productStockAfter: product.currentStock,
      };
    }

    // 2. InventoryItem authority (lazy creation with legacy bootstrap)
    const invItem = await this.ensureItemForRequest(tx, request, product, occurredAt, traceId);
    const direction = this.getDirection(request);
    const isReservation =
      request.mutationType === MutationType.RESERVATION || request.mutationType === MutationType.RESERVATION_RELEASE;

    // 3. Conditional, atomic InventoryItem update (the DB enforces the floor)
    if (isReservation) {
      const isLocking = request.mutationType === MutationType.RESERVATION;
      const updated = await tx.$executeRaw`
        UPDATE InventoryItem
        SET reserved = reserved ${isLocking ? Prisma.sql`+` : Prisma.sql`-`} ${qty},
            version = version + 1,
            updatedAt = NOW(3)
        WHERE id = ${invItem.id}
          AND shopId = ${request.shopId}
          ${isLocking && !request.allowNegative ? Prisma.sql`AND (onHand - reserved) >= ${qty}` : Prisma.empty}
          ${request.occ?.expectedInventoryItemVersion !== undefined ? Prisma.sql`AND version = ${request.occ.expectedInventoryItemVersion}` : Prisma.empty}
      `;
      if (updated === 0) {
        throw new InsufficientStockError(`Could not reserve stock for ${product.name}.`, await this.availability(tx, invItem.id));
      }
    } else if (direction === -1) {
      const allowNegative = request.allowNegative === true || invItem.isNegativeAllowed;
      const updated = await tx.$executeRaw`
        UPDATE InventoryItem
        SET onHand = onHand - ${qty},
            version = version + 1,
            updatedAt = NOW(3)
        WHERE id = ${invItem.id}
          AND shopId = ${request.shopId}
          ${allowNegative ? Prisma.empty : Prisma.sql`AND (onHand - reserved) >= ${qty}`}
          ${request.occ?.expectedInventoryItemVersion !== undefined ? Prisma.sql`AND version = ${request.occ.expectedInventoryItemVersion}` : Prisma.empty}
      `;
      if (updated === 0) {
        const current = await tx.inventoryItem.findUnique({ where: { id: invItem.id }, select: { version: true, onHand: true, reserved: true } });
        if (request.occ?.expectedInventoryItemVersion !== undefined && current?.version !== request.occ.expectedInventoryItemVersion) {
          throw new OptimisticLockConflictError('InventoryItem version conflict.');
        }
        throw new InsufficientStockError(`Insufficient stock for product ${product.name}`, {
          productId: request.productId,
          productName: product.name,
          requestedQty: request.quantity,
          availableQty: current ? current.onHand.minus(current.reserved).toNumber() : 0,
        });
      }
    } else {
      const updated = await tx.$executeRaw`
        UPDATE InventoryItem
        SET onHand = onHand + ${qty},
            version = version + 1,
            updatedAt = NOW(3)
        WHERE id = ${invItem.id}
          AND shopId = ${request.shopId}
          ${request.occ?.expectedInventoryItemVersion !== undefined ? Prisma.sql`AND version = ${request.occ.expectedInventoryItemVersion}` : Prisma.empty}
      `;
      if (updated === 0) {
        throw new OptimisticLockConflictError('InventoryItem version conflict.');
      }
    }

    const authoritativeItem = await tx.inventoryItem.findUniqueOrThrow({
      where: { id: invItem.id },
      select: { id: true, onHand: true, reserved: true, locationId: true },
    });
    const balanceAfter = authoritativeItem.onHand;

    // 4. Product.currentStock aggregate sync (OCC when the caller pre-read the version)
    let productStockAfter = product.currentStock;
    if (!isReservation) {
      if (request.occ?.expectedProductVersion !== undefined) {
        const sign = direction === -1 ? Prisma.sql`-` : Prisma.sql`+`;
        const updated = await tx.$executeRaw`
          UPDATE Product
          SET currentStock = currentStock ${sign} ${qty},
              stockVersion = stockVersion + 1,
              updatedAt = NOW(3)
          WHERE id = ${request.productId}
            AND shopId = ${request.shopId}
            AND stockVersion = ${request.occ.expectedProductVersion}
            AND isDeleted = false
        `;
        if (updated === 0) {
          const fresh = await tx.product.findUnique({ where: { id: request.productId }, select: { stockVersion: true, name: true } });
          if (!fresh) throw new InventoryNotFoundError('Product not found');
          throw new OptimisticLockConflictError(`Product optimistic lock conflict for ${fresh.name}`);
        }
      } else {
        await tx.product.updateMany({
          where: { id: request.productId, shopId: request.shopId },
          data:
            direction === -1
              ? { currentStock: { decrement: qty }, stockVersion: { increment: 1 } }
              : { currentStock: { increment: qty }, stockVersion: { increment: 1 } },
        });
      }
      const refreshed = await tx.product.findUnique({ where: { id: request.productId }, select: { currentStock: true } });
      productStockAfter = refreshed?.currentStock ?? productStockAfter;
    }

    // 5. Ledger + log + event (append-only)
    if (!isReservation) {
      const signedQty = direction === -1 ? qty.negated() : qty;
      await tx.stockLedgerEntry.create({
        data: {
          shopId: request.shopId,
          inventoryItemId: authoritativeItem.id,
          movementType: MOVEMENT_TYPE[request.mutationType](direction),
          quantity: signedQty,
          balanceAfter,
          referenceId: request.referenceId,
          referenceType: request.mutationType,
          correlationId: request.idempotencyKey || null,
          createdBy: request.performedBy,
          // createdAt is stamped by the database at insert time, i.e. after the
          // product lock, so ledger order equals posting order under contention.
        },
      });
      await tx.inventoryLog.create({
        data: {
          shopId: request.shopId,
          productId: request.productId,
          type: CHANGE_TYPE[request.mutationType](direction),
          quantityBefore: balanceAfter.minus(signedQty),
          quantityChange: signedQty,
          quantityAfter: balanceAfter,
          invoiceId: request.mutationType === MutationType.SALE || request.mutationType === MutationType.RETURN ? request.referenceId : null,
          recordedById: request.performedBy,
          notes: request.reason || request.mutationType,
        },
      });
    }

    await tx.productEventLog.create({
      data: {
        shopId: request.shopId,
        eventId: uuidv4(),
        eventType: 'InventoryChanged',
        entityId: authoritativeItem.id,
        entityType: 'InventoryItem',
        timestamp: occurredAt,
        payload: {
          inventoryItemId: authoritativeItem.id,
          productId: request.productId,
          locationId: authoritativeItem.locationId,
          mutationType: request.mutationType,
          quantityChange: direction === -1 ? -request.quantity : request.quantity,
          balanceAfter: balanceAfter.toString(),
          referenceId: request.referenceId,
          performedBy: request.performedBy,
        },
      },
    });

    return {
      bypassed: false,
      inventoryItemId: authoritativeItem.id,
      locationId: authoritativeItem.locationId,
      balanceAfter,
      availableAfter: authoritativeItem.onHand.minus(authoritativeItem.reserved),
      productStockAfter,
    };
  }

  /**
   * Finds the InventoryItem for (shop, product, location) or creates it.
   * Runs under the Product row lock taken in `mutateStock`, and the unique
   * index (shopId, productId, variantKey, locationId) rejects a duplicate if
   * anything ever bypasses that lock.
   *
   * Legacy bootstrap: products created before the inventory ledger existed
   * carry their stock only in `Product.currentStock`. When a product has no
   * InventoryItem rows at all and a positive currentStock, the first item is
   * seeded with that quantity and an OPENING_BALANCE ledger entry so that
   * `SUM(InventoryItem.onHand) == Product.currentStock` holds from day one.
   */
  private async ensureItemForRequest(
    tx: Prisma.TransactionClient,
    request: InventoryMutationRequest,
    product: { currentStock: Prisma.Decimal; name: string },
    occurredAt: Date,
    traceId: string,
  ): Promise<{ id: string; isNegativeAllowed: boolean; version: number }> {
    return this.ensureItem(tx, { shopId: request.shopId, productId: request.productId, locationId: request.locationId, variantId: null, performedBy: request.performedBy }, product, traceId);
  }

  /**
   * Public entry for other services (inventory screens, receipts) that need
   * the InventoryItem row to exist: takes the Product lock, then finds or
   * creates the row with the same legacy bootstrap the mutation path uses.
   */
  async ensureInventoryItem(
    tx: Prisma.TransactionClient,
    params: { shopId: string; productId: string; locationId: string; variantId?: string | null; performedBy?: string | null },
  ): Promise<{ id: string; isNegativeAllowed: boolean; version: number }> {
    await this.lockProducts(tx, params.shopId, [params.productId]);
    const product = await tx.product.findUnique({ where: { id: params.productId }, select: { currentStock: true, name: true, isDeleted: true } });
    if (!product || product.isDeleted) throw new InventoryNotFoundError(`Product ${params.productId} not found.`);
    return this.ensureItem(tx, params, product, uuidv4());
  }

  private async ensureItem(
    tx: Prisma.TransactionClient,
    params: { shopId: string; productId: string; locationId: string; variantId?: string | null; performedBy?: string | null },
    product: { currentStock: Prisma.Decimal; name: string },
    traceId: string,
  ): Promise<{ id: string; isNegativeAllowed: boolean; version: number }> {
    const variantId = params.variantId ?? null;
    const variantKey = variantId ?? '-';
    const existing = await tx.inventoryItem.findFirst({
      where: { shopId: params.shopId, productId: params.productId, locationId: params.locationId, variantKey },
      select: { id: true, isNegativeAllowed: true, version: true, isDeleted: true },
    });
    if (existing) {
      if (existing.isDeleted) {
        // The unique index still holds the row: revive it rather than failing the mutation.
        await tx.inventoryItem.update({ where: { id: existing.id }, data: { isDeleted: false, deletedAt: null } });
      }
      return { id: existing.id, isNegativeAllowed: existing.isNegativeAllowed, version: existing.version };
    }

    // Legacy bootstrap applies to the product-level row only (variantId null).
    const anyItem = await tx.inventoryItem.findFirst({
      where: { shopId: params.shopId, productId: params.productId, isDeleted: false },
      select: { id: true },
    });
    const bootstrapQty = variantId === null && !anyItem && product.currentStock.greaterThan(0) ? product.currentStock : new Prisma.Decimal(0);

    const created = await tx.inventoryItem.create({
      data: {
        shopId: params.shopId,
        productId: params.productId,
        variantId: variantId ?? undefined,
        variantKey,
        locationId: params.locationId,
        isNegativeAllowed: false,
        onHand: bootstrapQty,
        version: 0,
        createdBy: params.performedBy ?? null,
      },
      select: { id: true, isNegativeAllowed: true, version: true },
    });

    if (bootstrapQty.greaterThan(0)) {
      this.logger.log(`[${traceId}] Bootstrapped inventory item for ${product.name} from legacy currentStock=${bootstrapQty.toString()}`);
      await tx.stockLedgerEntry.create({
        data: {
          shopId: params.shopId,
          inventoryItemId: created.id,
          movementType: StockMovementType.OPENING_BALANCE,
          quantity: bootstrapQty,
          balanceAfter: bootstrapQty,
          referenceId: params.productId,
          referenceType: 'LEGACY_STOCK_BOOTSTRAP',
          createdBy: params.performedBy ?? 'SYSTEM',
        },
      });
      await tx.inventoryLog.create({
        data: {
          shopId: params.shopId,
          productId: params.productId,
          type: InventoryChangeType.OPENING,
          quantityBefore: 0,
          quantityChange: bootstrapQty,
          quantityAfter: bootstrapQty,
          recordedById: params.performedBy ?? 'SYSTEM',
          notes: 'Opening balance migrated from Product.currentStock',
        },
      });
    }
    return created;
  }

  private async availability(tx: Prisma.TransactionClient, inventoryItemId: string) {
    const current = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { onHand: true, reserved: true } });
    return { availableQty: current ? current.onHand.minus(current.reserved).toNumber() : 0 };
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryGateway } from '../inventory/inventory.gateway';
import { InventoryCacheService } from '../inventory/inventory-cache.service';
import { BillingActor, StockOutcome } from './billing.types';
import { safeTimeZone } from '../common/time/business-day';
import { invalidateAnalyticsCache } from '../common/cache/analytics-cache-keys';

/**
 * Side effects around the billing transaction: outbox staging (inside the
 * transaction) and post-commit propagation (Redis, websockets, audit of
 * rejected attempts). Post-commit work is best-effort and never throws.
 */
@Injectable()
export class BillingHelpers {
  private readonly logger = new Logger(BillingHelpers.name);
  private readonly tzCache = new Map<string, { tz: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryGateway: InventoryGateway,
    private readonly inventoryCache: InventoryCacheService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async shopTimeZone(shopId: string): Promise<string> {
    const cached = this.tzCache.get(shopId);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.tz;
    const settings = await this.prisma.shopSettings.findUnique({ where: { shopId }, select: { timezone: true } }).catch(() => null);
    const tz = safeTimeZone(settings?.timezone);
    this.tzCache.set(shopId, { tz, at: Date.now() });
    return tz;
  }

  /** Stage a domain event in the transactional outbox (same transaction as the business write). */
  async stageEvent(tx: Prisma.TransactionClient, actor: BillingActor, type: string, entityId: string, payload: Record<string, unknown>) {
    const eventId = crypto.randomUUID();
    await tx.outboxEvent.create({
      data: {
        id: eventId,
        shopId: actor.shopId,
        type,
        correlationId: actor.correlationId ?? null,
        actorId: actor.userId,
        entityId,
        entityType: 'Invoice',
        payload: {
          eventId,
          correlationId: actor.correlationId ?? null,
          shopId: actor.shopId,
          userId: actor.userId,
          createdAt: new Date().toISOString(),
          ...payload,
        },
      },
    });
  }

  /** After commit: sync Redis from authoritative values and push realtime stock updates. */
  async afterStockChange(actor: BillingActor, stock: StockOutcome[]): Promise<void> {
    // Dashboard KPIs are cached; drop them now so the next read reflects this
    // commit. The outbox processor invalidates again when the event is relayed,
    // which also covers a read that raced this commit and re-cached old figures.
    try {
      await invalidateAnalyticsCache(this.cache, actor.shopId);
    } catch (e) {
      this.logger.warn(`Analytics cache invalidation failed: ${(e as Error).message}`);
    }
    if (stock.length === 0) return;
    await this.inventoryCache.syncMany(stock.map((s) => ({ productId: s.productId, stock: s.productStockAfter })), actor.shopId);
    try {
      this.inventoryGateway.broadcastStockUpdate(stock.map((s) => ({ productId: s.productId, newStock: s.productStockAfter })));
    } catch (e) {
      this.logger.warn(`Stock broadcast failed: ${(e as Error).message}`);
    }
  }

  /** Audit a blocked business attempt (credit limit, insufficient stock). Best-effort, outside the transaction. */
  async auditRejected(actor: BillingActor, code: string, details: unknown): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'INVOICE_REJECTED',
          entity: 'Invoice',
          entityId: code,
          ipAddress: actor.ipAddress ?? null,
          afterData: { code, details: (details ?? null) as Prisma.InputJsonValue },
        },
      });
    } catch (e) {
      this.logger.warn(`Could not audit rejected attempt ${code}: ${(e as Error).message}`);
    }
  }
}

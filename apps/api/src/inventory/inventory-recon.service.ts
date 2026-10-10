import { Injectable, Logger, Inject, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import { CronLockService } from '../common/cron-lock/cron-lock.service';
import { DriftAlertService } from './drift-alert.service';
import { DriftStatus, InventoryChangeType, Prisma } from '@prisma/client';
import { InventoryFeatureConfig } from '../config/domains/features/inventory-feature.config';
import { CronConfig } from '../config/domains/cron.config';
import { CacheConfig } from '../config/domains/cache.config';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import Redis from 'ioredis';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { nextReconCursor, RECON_BATCH_ORDER, reconBatchWhere, ReconCursor } from './recon-keyset';

interface ReconProduct {
  id: string;
  shopId: string;
  currentStock: Prisma.Decimal;
  stockVersion: number;
  updatedAt: Date;
}

export interface ReconSummary {
  productsChecked: number;
  batches: number;
  ledgerDrifts: DriftCounters;
  redisDrifts: DriftCounters;
}

interface DriftCounters {
  found: number;
  fixed: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Periodic stock reconciliation. Two invariants, checked in this order per batch:
 *
 *  1. STOCK_CACHE_DRIFT : Product.currentStock == SUM(InventoryItem.onHand) for the
 *     product's non-deleted InventoryItem rows. The InventoryItem ledger is the
 *     authority; Product.currentStock is repaired to the sum (only for products
 *     that have at least one InventoryItem row).
 *  2. REDIS_STOCK_DRIFT : the Redis cache `stock:{shopId}:{productId}` must equal
 *     Product.currentStock (after step 1). Redis is repaired from the DB.
 *
 * Runs under a cron lock and as super-admin (Product and InventoryDriftLog are
 * tenant-scoped; InventoryItem is not and is always filtered by shopId).
 */
@Injectable()
export class InventoryReconService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InventoryReconService.name);

  constructor(
    @Inject(CACHE_MANAGER) private cache: Cache,
    @Inject(REDIS_CLIENT) private redis: Redis,
    private prisma: PrismaService,
    private cronLockService: CronLockService,
    private driftAlertService: DriftAlertService,
    private inventoryConfig: InventoryFeatureConfig,
    private cronConfig: CronConfig,
    private schedulerRegistry: SchedulerRegistry,
    private cacheConfig: CacheConfig,
    private tenantContextService: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn('InventoryRecon schedule not registered: CRON_ENABLED=false');
      return;
    }
    const job = new CronJob(this.cronConfig.inventoryReconCron, () => {
      void this.handleCron();
    });
    this.schedulerRegistry.addCronJob('InventoryRecon', job);
    job.start();
  }

  // Run scheduled reconciliation
  async handleCron() {
    await this.cronLockService.withLock(
      'inventory-reconciliation',
      this.inventoryConfig.reconLockTtlMs, // Configured TTL
      async () => {
        await this.tenantContextService.runAsSuperAdmin(async () => {
          await this.runReconciliation();
        });
      }
    );
  }

  /**
   * Walks every product updated inside the lookback window, in
   * `(updatedAt, id)` keyset pages over the `Product(updatedAt)` index
   * (roadmap 5.4, `recon-keyset.ts`), and repairs both invariants per page.
   */
  async runReconciliation(now: Date = new Date()): Promise<ReconSummary | null> {
    this.logger.log({ event: 'inventory_reconciliation_started' });
    const startTime = Date.now();

    if (!this.redis) {
      this.logger.warn('Redis client unavailable. Skipping reconciliation.');
      return null;
    }

    let productsChecked = 0;
    let batches = 0;
    const ledgerDrifts: DriftCounters = { found: 0, fixed: 0 };
    const redisDrifts: DriftCounters = { found: 0, fixed: 0 };

    const lookbackStart = new Date(now.getTime() - this.inventoryConfig.reconLookbackMs);
    const batchSize = this.inventoryConfig.reconBatchSize;
    let cursor: ReconCursor | null = null;

    try {
      while (true) {
        const products: ReconProduct[] = await this.prisma.product.findMany({
          where: reconBatchWhere(lookbackStart, now, cursor),
          select: { id: true, shopId: true, currentStock: true, stockVersion: true, updatedAt: true },
          take: batchSize,
          orderBy: RECON_BATCH_ORDER,
        });

        if (products.length === 0) break;

        productsChecked += products.length;
        batches += 1;
        cursor = nextReconCursor(products);

        // Invariant 1: ledger is the authority; repaired values are carried into invariant 2.
        const ledgerOutcome = await this.reconcileLedgerInvariant(products);
        ledgerDrifts.found += ledgerOutcome.found;
        ledgerDrifts.fixed += ledgerOutcome.fixed;

        // Invariant 2: Redis cache mirrors Product.currentStock.
        const redisOutcome = await this.reconcileRedisInvariant(products);
        redisDrifts.found += redisOutcome.found;
        redisDrifts.fixed += redisOutcome.fixed;

        if (products.length < batchSize) break;
      }
    } catch (error) {
      this.logger.error('Database or Redis unavailable. Aborting reconciliation cleanly.', error);
    }

    const durationMs = Date.now() - startTime;

    this.logger.log({
      event: 'inventory_reconciliation_completed',
      productsChecked,
      ledgerDriftsFound: ledgerDrifts.found,
      ledgerDriftsFixed: ledgerDrifts.fixed,
      redisDriftsFound: redisDrifts.found,
      redisDriftsFixed: redisDrifts.fixed,
      // Backwards-compatible totals
      driftsFound: ledgerDrifts.found + redisDrifts.found,
      driftsFixed: ledgerDrifts.fixed + redisDrifts.fixed,
      durationMs,
    });
    return { productsChecked, batches, ledgerDrifts, redisDrifts };
  }

  /**
   * Product.currentStock must equal SUM(InventoryItem.onHand) over the product's
   * non-deleted InventoryItem rows in its shop. Products without any
   * InventoryItem row are skipped (the ledger is not in use for them).
   * Mutates `product.currentStock` to the repaired value on success.
   */
  private async reconcileLedgerInvariant(products: ReconProduct[]): Promise<DriftCounters> {
    const counters: DriftCounters = { found: 0, fixed: 0 };
    if (products.length === 0) return counters;

    const productIds = products.map((p) => p.id);
    const shopIds = [...new Set(products.map((p) => p.shopId))];

    // InventoryItem is not tenant-scoped: filter shopId explicitly and match on (shopId, productId).
    const sums = await this.prisma.inventoryItem.groupBy({
      by: ['shopId', 'productId'],
      where: {
        shopId: { in: shopIds },
        productId: { in: productIds },
        isDeleted: false,
      },
      _sum: { onHand: true },
    });

    const ledgerByKey = new Map<string, Prisma.Decimal>();
    for (const row of sums) {
      ledgerByKey.set(`${row.shopId}:${row.productId}`, row._sum.onHand ?? new Prisma.Decimal(0));
    }

    for (const product of products) {
      const ledgerStock = ledgerByKey.get(`${product.shopId}:${product.id}`);
      if (ledgerStock === undefined) continue; // no InventoryItem rows for this product
      if (product.currentStock.equals(ledgerStock)) continue;

      counters.found++;
      const cachedStock = product.currentStock;
      const difference = cachedStock.minus(ledgerStock).abs();
      const correlationId = `ledger-drift-${Date.now()}-${product.id}`;

      // 1. Structured logging
      this.logger.warn({
        event: 'STOCK_CACHE_DRIFT',
        severity: 'WARN',
        shopId: product.shopId,
        productId: product.id,
        productCurrentStock: cachedStock.toString(),
        ledgerOnHand: ledgerStock.toString(),
        difference: difference.toString(),
        timestamp: new Date().toISOString(),
        correlationId,
      });

      // 2. Persistent drift audit record (DETECTED). redisValue holds the cached
      //    Product.currentStock, databaseValue the authoritative ledger sum.
      const driftLog = await this.prisma.inventoryDriftLog.create({
        data: {
          shopId: product.shopId,
          productId: product.id,
          redisValue: cachedStock,
          databaseValue: ledgerStock,
          difference,
          status: DriftStatus.DETECTED,
        },
      });

      // 3. Repair Product.currentStock from the ledger.
      //    `stockVersion` makes this a compare-and-swap against the row we read:
      //    InventoryMutationEngine bumps it on every sale, so a checkout that
      //    committed between the groupBy above and this write makes the update
      //    match zero rows. Without that guard the stale ledger sum would
      //    overwrite the sale's decrement and re-create the drift this job exists
      //    to repair. A contended row is left for the next run, not an error.
      try {
        const result = await this.prisma.product.updateMany({
          where: { id: product.id, shopId: product.shopId, stockVersion: product.stockVersion },
          data: { currentStock: ledgerStock, stockVersion: { increment: 1 } },
        });
        if (result.count === 0) {
          this.logger.warn(
            `Skipping repair of product ${product.id}: stock changed concurrently (stockVersion moved past ${product.stockVersion}); the next run re-evaluates it.`,
          );
          await this.prisma.inventoryDriftLog.update({
            where: { id: driftLog.id },
            data: { status: DriftStatus.DETECTED },
          });
          continue;
        }
        product.currentStock = ledgerStock;
        product.stockVersion += 1;

        // The correction is itself a stock event (roadmap 3.7, audit P2-28):
        // an InventoryLog row records what the cache said, what the ledger
        // holds and which drift record explains it.
        const recordedById = await this.systemActorFor(product.shopId);
        if (recordedById) {
          await this.prisma.inventoryLog.create({
            data: {
              shopId: product.shopId,
              productId: product.id,
              type: InventoryChangeType.ADJUSTMENT,
              quantityBefore: cachedStock,
              quantityChange: ledgerStock.minus(cachedStock),
              quantityAfter: ledgerStock,
              recordedById,
              notes: `Product.currentStock reconciled to the inventory ledger (drift ${driftLog.id})`,
            },
          });
        } else {
          this.logger.warn(`Shop ${product.shopId} has no owner: the reconciliation of product ${product.id} is recorded only in drift log ${driftLog.id}.`);
        }

        await this.prisma.inventoryDriftLog.update({
          where: { id: driftLog.id },
          data: { status: DriftStatus.REPAIRED, resolvedAt: new Date() },
        });

        await this.driftAlertService.notifyCriticalDrift({
          kind: 'STOCK_CACHE_DRIFT',
          driftId: driftLog.id,
          shopId: product.shopId,
          productId: product.id,
          repairedValue: ledgerStock.toString(),
          correlationId,
        });

        counters.fixed++;
      } catch (repairErr) {
        this.logger.error(`Failed to repair Product.currentStock for product ${product.id}: ${errorMessage(repairErr)}`);
        await this.prisma.inventoryDriftLog.update({
          where: { id: driftLog.id },
          data: { status: DriftStatus.FAILED },
        });

        await this.driftAlertService.notifyRepairFailure({
          kind: 'STOCK_CACHE_DRIFT',
          driftId: driftLog.id,
          shopId: product.shopId,
          productId: product.id,
          error: errorMessage(repairErr),
          correlationId,
        });
      }
    }

    return counters;
  }

  /** Redis `stock:{shopId}:{productId}` must equal Product.currentStock; Redis is repaired from the DB. */
  private async reconcileRedisInvariant(products: ReconProduct[]): Promise<DriftCounters> {
    const counters: DriftCounters = { found: 0, fixed: 0 };
    if (products.length === 0) return counters;

    // Fetch Redis values efficiently via pipeline
    const pipeline = this.redis.pipeline();
    products.forEach((p) => {
      pipeline.get(`stock:${p.shopId}:${p.id}`);
    });
    const redisResults = (await pipeline.exec()) ?? [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const dbStock = product.currentStock;
      const [err, redisRaw] = redisResults[i] ?? [new Error('Missing pipeline result'), null];

      if (err) {
        this.logger.error(`Failed to read Redis stock for product ${product.id}`, err);
        continue;
      }
      if (redisRaw === null || redisRaw === undefined) continue;

      let redisStock: Prisma.Decimal;
      try {
        redisStock = new Prisma.Decimal(String(redisRaw));
        if (redisStock.isNaN()) throw new Error('NaN');
      } catch {
        this.logger.error(`Unparsable Redis stock value '${String(redisRaw)}' for product ${product.id}; skipping.`);
        continue;
      }

      if (redisStock.equals(dbStock)) continue;

      counters.found++;
      const difference = dbStock.minus(redisStock).abs();
      const correlationId = `drift-${Date.now()}-${product.id}`;

      // 1. Structured Logging
      this.logger.warn({
        event: 'REDIS_STOCK_DRIFT',
        severity: 'WARN',
        shopId: product.shopId,
        productId: product.id,
        redisStock: redisStock.toString(),
        databaseStock: dbStock.toString(),
        difference: difference.toString(),
        timestamp: new Date().toISOString(),
        correlationId,
      });

      // 2. Persistent Drift Audit Record (DETECTED)
      const driftLog = await this.prisma.inventoryDriftLog.create({
        data: {
          shopId: product.shopId,
          productId: product.id,
          redisValue: redisStock,
          databaseValue: dbStock,
          difference,
          status: DriftStatus.DETECTED,
        },
      });

      // 3. Attempt Redis Repair
      try {
        await this.redis.set(
          `stock:${product.shopId}:${product.id}`,
          dbStock.toString(),
          'EX',
          this.cacheConfig.inventoryDriftTtlSeconds,
        );

        await this.prisma.inventoryDriftLog.update({
          where: { id: driftLog.id },
          data: { status: DriftStatus.REPAIRED, resolvedAt: new Date() },
        });

        await this.driftAlertService.notifyCriticalDrift({
          kind: 'REDIS_STOCK_DRIFT',
          driftId: driftLog.id,
          shopId: product.shopId,
          productId: product.id,
          repairedValue: dbStock.toString(),
          correlationId,
        });

        counters.fixed++;
      } catch (repairErr) {
        this.logger.error(`Failed to repair Redis stock for product ${product.id}: ${errorMessage(repairErr)}`);
        await this.prisma.inventoryDriftLog.update({
          where: { id: driftLog.id },
          data: { status: DriftStatus.FAILED },
        });

        await this.driftAlertService.notifyRepairFailure({
          kind: 'REDIS_STOCK_DRIFT',
          driftId: driftLog.id,
          shopId: product.shopId,
          productId: product.id,
          error: errorMessage(repairErr),
          correlationId,
        });
      }
    }

    return counters;
  }
  private readonly systemActors = new Map<string, string | null>();

  /** InventoryLog.recordedById is a User: system corrections are recorded under the shop owner. */
  private async systemActorFor(shopId: string): Promise<string | null> {
    const cached = this.systemActors.get(shopId);
    if (cached !== undefined) return cached;
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
    const ownerId = shop?.ownerId ?? null;
    this.systemActors.set(shopId, ownerId);
    return ownerId;
  }

}

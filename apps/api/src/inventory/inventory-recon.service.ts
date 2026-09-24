import { Injectable, Logger, Inject, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import { CronLockService } from '../common/cron-lock/cron-lock.service';
import { DriftAlertService } from './drift-alert.service';
import { DriftStatus, Prisma } from '@prisma/client';
import { InventoryFeatureConfig } from '../config/domains/features/inventory-feature.config';
import { CronConfig } from '../config/domains/cron.config';
import { CacheConfig } from '../config/domains/cache.config';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import Redis from 'ioredis';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';

interface ReconProduct {
  id: string;
  shopId: string;
  currentStock: Prisma.Decimal;
  stockVersion: number;
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

  async runReconciliation() {
    this.logger.log({ event: 'inventory_reconciliation_started' });
    const startTime = Date.now();

    if (!this.redis) {
      this.logger.warn('Redis client unavailable. Skipping reconciliation.');
      return;
    }

    let productsChecked = 0;
    const ledgerDrifts: DriftCounters = { found: 0, fixed: 0 };
    const redisDrifts: DriftCounters = { found: 0, fixed: 0 };

    const lookbackStart = new Date(Date.now() - this.inventoryConfig.reconLookbackMs);
    const batchSize = this.inventoryConfig.reconBatchSize;
    let skip = 0;

    try {
      while (true) {
        // Fetch from Prisma in batches
        const products: ReconProduct[] = await this.prisma.product.findMany({
          where: {
            updatedAt: { gte: lookbackStart },
            isDeleted: false,
          },
          select: { id: true, shopId: true, currentStock: true, stockVersion: true },
          take: batchSize,
          skip: skip,
          orderBy: { id: 'asc' },
        });

        if (products.length === 0) break;

        productsChecked += products.length;

        // Invariant 1: ledger is the authority; repaired values are carried into invariant 2.
        const ledgerOutcome = await this.reconcileLedgerInvariant(products);
        ledgerDrifts.found += ledgerOutcome.found;
        ledgerDrifts.fixed += ledgerOutcome.fixed;

        // Invariant 2: Redis cache mirrors Product.currentStock.
        const redisOutcome = await this.reconcileRedisInvariant(products);
        redisDrifts.found += redisOutcome.found;
        redisDrifts.fixed += redisOutcome.fixed;

        skip += batchSize;
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
}

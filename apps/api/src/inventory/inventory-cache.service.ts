import { Injectable, Inject, Logger } from '@nestjs/common';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CacheConfig } from '../config/domains/cache.config';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import type Redis from 'ioredis';

export type StockPrecheck = 'ok' | 'insufficient' | 'cache_miss';

/**
 * Redis stock fast-path.
 *
 * Redis is NEVER authoritative. Keys `stock:{shopId}:{productId}` hold the
 * last known Product.currentStock so that hot products can reject obviously
 * impossible sales before opening a database transaction. Every operation
 * here is best-effort: any Redis failure degrades to the database path.
 *
 * Invariants:
 *  - a key is only ever created by `syncStock` (from an authoritative value)
 *    or by the Lua decrement of an existing key; `restoreStock` never
 *    creates keys, so a missing key can never be "poisoned" into a wrong
 *    positive value;
 *  - every write keeps the configured TTL so drift self-expires.
 */
@Injectable()
export class InventoryCacheService {
  private readonly logger = new Logger(InventoryCacheService.name);

  // Atomic check-and-decrement that preserves the key's TTL.
  private static readonly DECREMENT_LUA = `
    local current = tonumber(redis.call('GET', KEYS[1]))
    if current == nil then return '-2' end
    local qty = tonumber(ARGV[1])
    if current < qty then return '-1' end
    local newVal = current - qty
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > 0 then
      redis.call('SET', KEYS[1], tostring(newVal), 'EX', ttl)
    else
      redis.call('SET', KEYS[1], tostring(newVal), 'EX', tonumber(ARGV[2]))
    end
    return tostring(newVal)
  `;

  // Increment only when the key exists (compensation must not create keys).
  private static readonly RESTORE_LUA = `
    if redis.call('EXISTS', KEYS[1]) == 0 then return '-2' end
    local newVal = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
    local ttl = redis.call('TTL', KEYS[1])
    if ttl <= 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
    return newVal
  `;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantContext: TenantContextService,
    private readonly cacheConfig: CacheConfig,
  ) {}

  private key(productId: string, shopId?: string): string {
    return `stock:${shopId ?? this.tenantContext.getShopId()}:${productId}`;
  }

  private get ttl(): number {
    return this.cacheConfig.inventoryStockTtlSeconds;
  }

  /** Atomic pre-decrement BEFORE the DB transaction. Never throws. */
  async tryDecrementStock(productId: string, quantity: number, shopId?: string): Promise<StockPrecheck> {
    try {
      const result = await this.redis.eval(InventoryCacheService.DECREMENT_LUA, 1, this.key(productId, shopId), quantity.toString(), this.ttl.toString());
      if (result === '-1') return 'insufficient';
      if (result === '-2') return 'cache_miss';
      return 'ok';
    } catch (e) {
      this.logger.warn(`Redis pre-check unavailable for ${productId}: ${(e as Error).message}`);
      return 'cache_miss';
    }
  }

  /** Compensation after a failed transaction; only touches existing keys. Never throws. */
  async restoreStock(productId: string, quantity: number, shopId?: string): Promise<void> {
    try {
      await this.redis.eval(InventoryCacheService.RESTORE_LUA, 1, this.key(productId, shopId), quantity.toString(), this.ttl.toString());
    } catch (e) {
      this.logger.warn(`Redis restore failed for ${productId}: ${(e as Error).message}`);
    }
  }

  /** Set the cached value from an authoritative DB value. Never throws. */
  async syncStock(productId: string, newStock: number | string, shopId?: string): Promise<void> {
    try {
      await this.redis.set(this.key(productId, shopId), newStock.toString(), 'EX', this.ttl);
    } catch (e) {
      this.logger.warn(`Redis sync failed for ${productId}: ${(e as Error).message}`);
    }
  }

  async syncMany(entries: Array<{ productId: string; stock: number | string }>, shopId?: string): Promise<void> {
    if (entries.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const e of entries) pipeline.set(this.key(e.productId, shopId), e.stock.toString(), 'EX', this.ttl);
      await pipeline.exec();
    } catch (e) {
      this.logger.warn(`Redis bulk sync failed: ${(e as Error).message}`);
    }
  }

  /** Drop cached values so the next read goes to the database. Never throws. */
  async invalidate(productIds: string[], shopId?: string): Promise<void> {
    if (productIds.length === 0) return;
    try {
      await this.redis.del(...productIds.map((id) => this.key(id, shopId)));
    } catch (e) {
      this.logger.warn(`Redis invalidate failed: ${(e as Error).message}`);
    }
  }

  /** Cached value or null on miss/failure. */
  async getStock(productId: string, shopId?: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(this.key(productId, shopId));
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
}

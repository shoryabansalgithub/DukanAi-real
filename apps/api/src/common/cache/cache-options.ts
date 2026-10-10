import { Logger } from '@nestjs/common';
import { CacheModuleOptions } from '@nestjs/cache-manager';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { CacheConfig } from '../../config/domains/cache.config';
import { RedisConfig } from '../../config/domains/redis.config';

/** Every cache key in Redis is `cache:<key>`; the throttler uses `throttle:`, stock keys `stock:`. */
export const CACHE_NAMESPACE = 'cache';

/**
 * Cache store options for `CacheModule` (roadmap 2.11, audit P2-11). With
 * `REDIS_URL` the cache lives in Redis through a Keyv store, so every API
 * instance reads the same entries and an invalidation on one instance
 * (`BillingHelpers.afterStockChange`, the outbox processor) is seen by all.
 * The former `cache-manager-redis-yet` store was silently ignored by
 * cache-manager 7 (it reads `stores`, not `store`), which left an unbounded
 * per-process Map. Without `REDIS_URL` the cache stays in memory, which is
 * only fit for a single development process.
 *
 * Redis errors never fail a request: the Keyv store swallows them (a miss),
 * they are logged, and the callers already treat the cache as advisory. They
 * never stall one either: commands are not queued while Redis is unreachable.
 */
export function buildCacheOptions(redisConfig: RedisConfig, cacheConfig: CacheConfig, logger: Logger = new Logger('CacheModule')): CacheModuleOptions {
  if (!redisConfig.redisUrl) {
    logger.warn('REDIS_URL not configured: the cache is in-process and not shared between instances');
    return { ttl: cacheConfig.ttl };
  }
  // Keyv hands its namespace to the adapter, which prefixes every key once as
  // `cache:<key>`; Keyv's own prefix is switched off so it is not applied twice.
  // Fail fast while Redis is away (roadmap 9.18): node-redis queues commands
  // offline by default and resolves them only when Redis returns, so during
  // the 5-minute Redis drill every checkout (its post-commit invalidation)
  // and every dashboard read hung until the client gave up. With the offline
  // queue off a command answers at once with an error, which Keyv turns into
  // a miss; the client keeps reconnecting in the background.
  const store = new KeyvRedis(
    {
      url: redisConfig.redisUrl,
      disableOfflineQueue: true,
      socket: { connectTimeout: redisConfig.connectTimeoutMs, reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 2_000) },
    },
    { keyPrefixSeparator: ':', useUnlink: true, throwOnErrors: false, connectionTimeout: redisConfig.connectTimeoutMs },
  );
  const keyv = new Keyv({ store, ttl: cacheConfig.ttl, namespace: CACHE_NAMESPACE, useKeyPrefix: false });
  // Keyv re-emits the adapter's errors; without a listener they would be unhandled.
  keyv.on('error', (error: unknown) => logger.warn(`Cache store error: ${error instanceof Error ? error.message : String(error)}`));
  return { stores: [keyv], ttl: cacheConfig.ttl };
}

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
 * never stall one either: commands are not queued while Redis is unreachable,
 * and every command has a reply deadline.
 */
/** Keeps the connection honest on deployments that do not honour TCP keep-alive (managed Redis, NAT). */
export const CACHE_PING_INTERVAL_MS = 10_000;
/** A socket with no traffic at all for this long is closed and reconnected (the pings keep a healthy one busy). */
export const CACHE_SOCKET_TIMEOUT_MS = 30_000;

export interface CacheOptionsBehaviour {
  /** Open the connection now instead of on the first command (default true; the unit specs pass false). */
  eagerConnect?: boolean;
}

export function buildCacheOptions(
  redisConfig: RedisConfig,
  cacheConfig: CacheConfig,
  logger: Logger = new Logger('CacheModule'),
  behaviour: CacheOptionsBehaviour = {},
): CacheModuleOptions {
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
  //
  // Audit R3: a Redis that accepts the connection but never answers (a
  // blackholed address, a stalled failover) is bounded too: every command
  // carries REDIS_COMMAND_TIMEOUT_MS (node-redis `commandOptions.timeout`),
  // PING every CACHE_PING_INTERVAL_MS notices a dead peer, and a socket idle
  // for CACHE_SOCKET_TIMEOUT_MS is replaced.
  const store = new KeyvRedis(
    {
      url: redisConfig.redisUrl,
      disableOfflineQueue: true,
      pingInterval: CACHE_PING_INTERVAL_MS,
      commandOptions: { timeout: redisConfig.commandTimeoutMs },
      socket: {
        connectTimeout: redisConfig.connectTimeoutMs,
        socketTimeout: CACHE_SOCKET_TIMEOUT_MS,
        reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 2_000),
      },
    },
    { keyPrefixSeparator: ':', useUnlink: true, throwOnErrors: false, connectionTimeout: redisConfig.connectTimeoutMs },
  );
  const keyv = new Keyv({ store, ttl: cacheConfig.ttl, namespace: CACHE_NAMESPACE, useKeyPrefix: false });
  // Keyv re-emits the adapter's errors; without a listener they would be unhandled.
  keyv.on('error', (error: unknown) => logger.warn(`Cache store error: ${error instanceof Error ? error.message : String(error)}`));
  if (behaviour.eagerConnect !== false) {
    // Audit R4: the adapter connects on first use and races that connect
    // against its connection timeout on EVERY call while the client is not
    // open, then closes it again: with Redis down at boot each cache call cost
    // REDIS_CONNECT_TIMEOUT_MS. Opened here, the client stays open and keeps
    // reconnecting in the background, and until it is ready every command
    // fails at once (no offline queue). Boot never waits for it.
    void store.client.connect().catch((error: unknown) => logger.warn(`Cache store not connected: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { stores: [keyv], ttl: cacheConfig.ttl };
}

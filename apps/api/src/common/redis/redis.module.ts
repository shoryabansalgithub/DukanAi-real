import { Global, Module, Logger } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { RedisConfig } from '../../config/domains/redis.config';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export type RedisClientTuning = Pick<RedisConfig, 'connectTimeoutMs' | 'commandTimeoutMs' | 'maxRetriesPerRequest'>;

/**
 * Fail-fast options for the shared application client (cache, pub/sub, cron
 * locks). When Redis is down, callers get a rejection within a bounded time
 * instead of commands piling up in ioredis' offline queue until it comes back.
 *
 * BullMQ does NOT use this client: it builds its own connection from BullConfig
 * in app.module.ts, where `maxRetriesPerRequest: null` is required.
 */
export function buildRedisOptions(tuning: RedisClientTuning): RedisOptions {
  return {
    maxRetriesPerRequest: tuning.maxRetriesPerRequest,
    enableOfflineQueue: false,
    connectTimeout: tuning.connectTimeoutMs,
    commandTimeout: tuning.commandTimeoutMs,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  };
}

export function createRedisClient(redisConfig: RedisConfig, logger: Logger = new Logger('RedisModule')): Redis {
  const options = buildRedisOptions(redisConfig);
  const url = redisConfig.redisUrl;

  let client: Redis;
  if (url) {
    client = new Redis(url, options);
  } else {
    logger.warn('REDIS_URL not configured. Redis-backed features will fail fast until it is set.');
    // No URL: never dial localhost at boot; the first command fails fast instead.
    client = new Redis({ ...options, lazyConnect: true });
  }

  // ioredis emits 'error' on every failed (re)connect attempt; without a listener
  // the process would crash on an unhandled 'error' event.
  client.on('error', (error: Error) => {
    logger.warn(`Redis client error: ${error.message}`);
  });
  client.on('reconnecting', (delayMs: number) => {
    logger.debug(`Redis client reconnecting in ${delayMs}ms`);
  });
  client.on('ready', () => {
    logger.log('Redis client ready');
  });
  client.on('end', () => {
    logger.warn('Redis client connection ended');
  });

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (redisConfig: RedisConfig) => createRedisClient(redisConfig),
      inject: [RedisConfig],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

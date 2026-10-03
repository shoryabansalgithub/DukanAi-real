import { Logger } from '@nestjs/common';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { CacheConfig } from '../../config/domains/cache.config';
import { RedisConfig } from '../../config/domains/redis.config';
import { buildCacheOptions, CACHE_NAMESPACE } from './cache-options';

describe('buildCacheOptions', () => {
  const cacheConfig = Object.assign(new CacheConfig(), { ttl: 1234 });
  const logger = { warn: jest.fn() } as unknown as Logger;

  it('backs the cache with a Keyv Redis store under the cache namespace when REDIS_URL is set', () => {
    const options = buildCacheOptions(Object.assign(new RedisConfig(), { redisUrl: 'redis://127.0.0.1:6379/3' }), cacheConfig, logger) as {
      stores: Keyv[];
      ttl: number;
    };
    expect(options.ttl).toBe(1234);
    expect(options.stores).toHaveLength(1);
    const keyv = options.stores[0];
    expect(keyv).toBeInstanceOf(Keyv);
    expect(keyv.opts.store).toBeInstanceOf(KeyvRedis);
    expect(keyv.opts.namespace).toBe(CACHE_NAMESPACE);
    expect((keyv.opts.store as KeyvRedis<unknown>).namespace).toBe(CACHE_NAMESPACE); // handed down to the adapter
    expect(keyv.opts.useKeyPrefix).toBe(false); // the adapter prefixes `cache:` once
    expect(keyv.opts.ttl).toBe(1234);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to an in-process cache without REDIS_URL and says so', () => {
    const options = buildCacheOptions(new RedisConfig(), cacheConfig, logger);
    expect(options).toEqual({ ttl: 1234 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not shared'));
  });
});

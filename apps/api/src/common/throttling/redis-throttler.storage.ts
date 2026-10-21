import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type Redis from 'ioredis';

/**
 * One round trip per request: count the hit, start the window on its first
 * hit, and open a block for `blockMs` once the limit is exceeded. While a
 * block is open hits are not counted (as in the in-memory storage); the hit
 * counter expires with the block so the window restarts cleanly afterwards.
 *
 * KEYS[1] hit counter, KEYS[2] block marker.
 * ARGV[1] window ms, ARGV[2] limit, ARGV[3] block ms.
 * Returns { hits, windowLeftMs, blocked(0|1), blockLeftMs }.
 */
const INCREMENT_SCRIPT = `
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  local windowLeft = redis.call('PTTL', KEYS[1])
  if windowLeft < 0 then windowLeft = 0 end
  return { hits, windowLeft, 1, blockLeft }
end
local hits = redis.call('INCR', KEYS[1])
local windowLeft = redis.call('PTTL', KEYS[1])
if windowLeft < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
  windowLeft = windowMs
end
if hits > limit then
  redis.call('SET', KEYS[2], '1', 'PX', blockMs)
  redis.call('PEXPIRE', KEYS[1], blockMs)
  return { hits, blockMs, 1, blockMs }
end
return { hits, windowLeft, 0, 0 }
`;

/** The record the guard expects back (not exported by the package root). */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export const THROTTLE_KEY_PREFIX = 'throttle:';

/** Redis keys for one throttle bucket; the hash tag keeps both on one cluster slot. */
export function throttleKeys(key: string): { hits: string; block: string } {
  return { hits: `${THROTTLE_KEY_PREFIX}{${key}}:hits`, block: `${THROTTLE_KEY_PREFIX}{${key}}:block` };
}

const toSeconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * `@nestjs/throttler` storage on the shared application Redis client, so every
 * API instance counts against the same buckets (the default storage is a
 * per-process Map). Time values are returned in whole seconds, the unit the
 * guard writes into `Retry-After` / `X-RateLimit-Reset`.
 *
 * When Redis is unreachable the call degrades to the per-process in-memory
 * storage instead of failing the request, and the outage is logged once until
 * Redis answers again: the limiter keeps working per instance rather than
 * turning every request into a 500 or waving all of them through.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private degraded = false;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger = new Logger(RedisThrottlerStorage.name),
    private readonly fallback: ThrottlerStorageService = new ThrottlerStorageService(),
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const keys = throttleKeys(key);
    let reply: unknown;
    try {
      reply = await this.redis.eval(INCREMENT_SCRIPT, 2, keys.hits, keys.block, String(ttl), String(limit), String(blockDuration));
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(`Redis unavailable for rate limiting, counting per process until it returns: ${errorMessage(error)}`);
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
    if (this.degraded) {
      this.degraded = false;
      this.logger.log('Redis rate-limit counters are back in use');
    }
    const [hits, windowLeftMs, blocked, blockLeftMs] = reply as [number, number, number, number];
    return {
      totalHits: Number(hits),
      timeToExpire: toSeconds(Number(windowLeftMs)),
      isBlocked: Number(blocked) === 1,
      timeToBlockExpire: toSeconds(Number(blockLeftMs)),
    };
  }

  onApplicationShutdown(): void {
    this.fallback.onApplicationShutdown();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

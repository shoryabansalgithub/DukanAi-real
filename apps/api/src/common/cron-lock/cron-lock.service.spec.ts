import Redis from 'ioredis';
import { CronLockService, extensionIntervalMs, redisLockClient } from './cron-lock.service';

/** Audit R9: a cron lock is held for the whole run, however long the run takes. */
describe('CronLockService', () => {
  function fakeLock(log: string[], id = 0): { extend: jest.Mock; release: jest.Mock } {
    const lock = {
      extend: jest.fn(async () => {
        log.push(`extend ${id}`);
        return fakeLock(log, id + 1);
      }),
      release: jest.fn(async () => {
        log.push(`release ${id}`);
      }),
    };
    return lock;
  }

  function service(log: string[]): CronLockService {
    const svc = new CronLockService({ status: 'ready' } as never);
    (svc as unknown as { locker: unknown }).locker = { acquire: jest.fn(async () => fakeLock(log)) };
    return svc;
  }

  it('extends the lock while a run outlives its TTL, and releases the newest lock at the end', async () => {
    const log: string[] = [];
    const result = await service(log).withLock('cron:slow', 1_500, async () => {
      await new Promise((r) => setTimeout(r, 2_300));
      return 'done';
    });
    expect(result).toBe('done');
    // Interval = max(1 s, TTL / 3): extended at ~1 s and ~2 s, then the latest lock is released.
    expect(log).toEqual(['extend 0', 'extend 1', 'release 2']);
  });

  it('a run within its TTL is never extended', async () => {
    const log: string[] = [];
    await service(log).withLock('cron:quick', 60_000, async () => undefined);
    expect(log).toEqual(['release 0']);
  });

  it('a failed extension is logged and the run goes on', async () => {
    const svc = new CronLockService({ status: 'ready' } as never);
    const release = jest.fn(async () => undefined);
    (svc as unknown as { locker: unknown }).locker = { acquire: jest.fn(async () => ({ extend: jest.fn(async () => Promise.reject(new Error('redis gone'))), release })) };
    const error = jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await expect(svc.withLock('cron:x', 1_000, () => new Promise((r) => setTimeout(() => r('ok'), 1_200)))).resolves.toBe('ok');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be extended'));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('extends at a third of the TTL, never more often than once a second', () => {
    expect(extensionIntervalMs(55_000)).toBe(18_333);
    expect(extensionIntervalMs(900)).toBe(1_000);
  });
});

/**
 * The lock itself on a real Redis (the test server's db, `TEST_REDIS_URL` or
 * the .env.test default): skipped when no Redis answers.
 */
describe('redisLockClient (SET NX PX, token-checked extend and release)', () => {
  let redis: Redis | null = null;
  beforeAll(async () => {
    const url = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/1';
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1_000, retryStrategy: () => null });
    try {
      await client.connect();
      redis = client;
    } catch {
      client.disconnect();
    }
  });
  afterAll(async () => {
    await redis?.quit();
  });
  const key = () => `cron:lock-spec-${Math.random().toString(36).slice(2)}`;

  it('one holder at a time; release frees it; a stale holder never releases or extends a newer lock', async () => {
    if (!redis) return;
    const locks = redisLockClient(redis);
    const resource = key();
    const first = await locks.acquire(resource, 5_000);
    expect(first).not.toBeNull();
    expect(await locks.acquire(resource, 5_000)).toBeNull();
    await first!.release();
    const second = await locks.acquire(resource, 5_000);
    expect(second).not.toBeNull();
    // The first holder's lock is gone: releasing or extending it touches nothing of the second's.
    await first!.release();
    await expect(first!.extend(5_000)).rejects.toThrow('no longer held');
    expect(await locks.acquire(resource, 5_000)).toBeNull();
    await second!.release();
  });

  it('extend keeps the lock past its first TTL; without it the lock expires', async () => {
    if (!redis) return;
    const locks = redisLockClient(redis);
    const kept = key();
    const lock = await locks.acquire(kept, 300);
    await new Promise((r) => setTimeout(r, 150));
    const extended = await lock!.extend(1_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await locks.acquire(kept, 300)).toBeNull();
    await extended.release();

    const lapsed = key();
    await locks.acquire(lapsed, 150);
    await new Promise((r) => setTimeout(r, 300));
    const again = await locks.acquire(lapsed, 1_000);
    expect(again).not.toBeNull();
    await again!.release();
  });
});

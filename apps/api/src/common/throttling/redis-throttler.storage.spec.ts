import { Logger } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { RedisThrottlerStorage, throttleKeys } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  const logger = { warn: jest.fn(), log: jest.fn() } as unknown as Logger;
  beforeEach(() => jest.clearAllMocks());

  it('runs one script per hit on both bucket keys and converts the reply to whole seconds', async () => {
    const evalMock = jest.fn().mockResolvedValue([4, 9_400, 1, 9_400]);
    const storage = new RedisThrottlerStorage({ eval: evalMock } as unknown as Redis, logger);

    const record = await storage.increment('abc', 10_000, 3, 10_000, 'auth-short');

    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(evalMock.mock.calls[0].slice(1)).toEqual([2, 'throttle:{abc}:hits', 'throttle:{abc}:block', '10000', '3', '10000']);
    expect(record).toEqual({ totalHits: 4, timeToExpire: 10, isBlocked: true, timeToBlockExpire: 10 });
  });

  it('keeps both keys of a bucket on one cluster hash slot', () => {
    expect(throttleKeys('k')).toEqual({ hits: 'throttle:{k}:hits', block: 'throttle:{k}:block' });
  });

  it('degrades to the in-memory storage while Redis is unreachable and logs the outage once', async () => {
    const evalMock = jest.fn().mockRejectedValue(new Error('Connection is closed'));
    const fallback = new ThrottlerStorageService();
    const storage = new RedisThrottlerStorage({ eval: evalMock } as unknown as Redis, logger, fallback);

    const first = await storage.increment('k', 60_000, 2, 60_000, 'short');
    const second = await storage.increment('k', 60_000, 2, 60_000, 'short');
    const third = await storage.increment('k', 60_000, 2, 60_000, 'short');

    expect([first.totalHits, second.totalHits, third.totalHits]).toEqual([1, 2, 3]);
    expect(third.isBlocked).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Connection is closed'));

    evalMock.mockResolvedValue([1, 60_000, 0, 0]);
    const recovered = await storage.increment('k', 60_000, 2, 60_000, 'short');
    expect(recovered).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('back in use'));

    storage.onApplicationShutdown(); // clears the fallback's timers
  });
});

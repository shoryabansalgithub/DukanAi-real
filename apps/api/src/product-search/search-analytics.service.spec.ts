import { SearchFeatureConfig } from '../config/domains/features/search-feature.config';
import { SearchAnalyticsService } from './search-analytics.service';

describe('SearchAnalyticsService (roadmap 5.3)', () => {
  const config = Object.assign(new SearchFeatureConfig(), { historyMaxPerMinute: 3 });
  let create: jest.Mock;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({});
  });

  /** A fake ioredis MULTI: INCR + PEXPIRE NX in one round trip, replies as [[err, value], ...]. */
  const fakeRedis = (exec: (key: string) => Promise<Array<[Error | null, unknown]> | null>) => {
    const incr = jest.fn(); const pexpire = jest.fn();
    const redis = {
      multi: jest.fn(() => {
        let key = '';
        type Chain = { incr: (k: string) => Chain; pexpire: (k: string, ms: number, flag: string) => Chain; exec: () => Promise<Array<[Error | null, unknown]> | null> };
        const chain: Chain = {
          incr: (k) => { key = k; incr(k); return chain; },
          pexpire: (k, ms, flag) => { pexpire(k, ms, flag); return chain; },
          exec: () => exec(key),
        };
        return chain;
      }),
    };
    return { redis, incr, pexpire };
  };

  it('counts inserts per shop and minute in Redis (INCR and PEXPIRE NX in one MULTI) and stops recording past the budget', async () => {
    let hits = 0;
    const { redis, incr, pexpire } = fakeRedis(async () => [[null, ++hits], [null, 1]]);
    const service = new SearchAnalyticsService({ searchHistory: { create } } as never, config, redis as never);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) outcomes.push(await service.logSearch('shop-1', 'u1', 'tea', 1, 5));
    expect(outcomes).toEqual([true, true, true, false, false]);
    expect(create).toHaveBeenCalledTimes(3);
    expect(incr.mock.calls[0][0]).toMatch(/^search-history:shop-1:\d+$/);
    expect(pexpire).toHaveBeenCalledTimes(5); // sent with every INCR; NX makes it a no-op once the TTL exists
    expect(pexpire.mock.calls[0][2]).toBe('NX');
  });

  it('falls back to a per-process counter when Redis fails, and stores a capped query', async () => {
    const { redis } = fakeRedis(() => Promise.reject(new Error('ECONNREFUSED')));
    const service = new SearchAnalyticsService({ searchHistory: { create } } as never, config, redis as never);
    const long = 'x'.repeat(500);
    expect(await service.logSearch('shop-1', null, long, 0, 1)).toBe(true);
    expect(create.mock.calls[0][0].data.query.length).toBeLessThanOrEqual(100);
    expect(await service.logSearch('shop-1', null, 'a', 0, 1)).toBe(true);
    expect(await service.logSearch('shop-1', null, 'b', 0, 1)).toBe(true);
    expect(await service.logSearch('shop-1', null, 'c', 0, 1)).toBe(false);
    expect(await service.logSearch('shop-2', null, 'c', 0, 1)).toBe(true); // budgets are per shop
  });

  it('works without a Redis client at all', async () => {
    const service = new SearchAnalyticsService({ searchHistory: { create } } as never, config);
    expect(await service.logSearch('shop-1', null, 'tea', 1, 1)).toBe(true);
  });
});

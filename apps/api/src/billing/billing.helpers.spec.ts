import { BillingHelpers } from './billing.helpers';
import { analyticsCacheKeys } from '../common/cache/analytics-cache-keys';

describe('BillingHelpers.afterStockChange', () => {
  const actor = { shopId: 'shop-7', userId: 'user-1', role: 'OWNER' } as never;

  function build(cacheDel: jest.Mock) {
    const inventoryCache = { syncMany: jest.fn().mockResolvedValue(undefined) };
    const gateway = { broadcastStockUpdate: jest.fn() };
    const helpers = new BillingHelpers({} as never, gateway as never, inventoryCache as never, { mdel: cacheDel } as never);
    return { helpers, inventoryCache, gateway };
  }

  it('drops the analytics cache right after a commit, even when no stock moved (custom-only invoice)', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const { helpers, inventoryCache } = build(del);

    await helpers.afterStockChange(actor, []);

    // One round trip for every key (audit R3).
    expect(del.mock.calls).toEqual([[analyticsCacheKeys('shop-7')]]);
    expect(inventoryCache.syncMany).not.toHaveBeenCalled();
  });

  it('never fails the committed sale when the cache store is down', async () => {
    const del = jest.fn().mockRejectedValue(new Error('redis down'));
    const { helpers, inventoryCache, gateway } = build(del);

    await expect(
      helpers.afterStockChange(actor, [{ productId: 'p1', productStockAfter: '4' }] as never),
    ).resolves.toBeUndefined();
    expect(inventoryCache.syncMany).toHaveBeenCalled();
    expect(gateway.broadcastStockUpdate).toHaveBeenCalled();
  });

  it('answers the committed sale within the invalidation budget when Redis never replies (audit R3)', async () => {
    const del = jest.fn(() => new Promise(() => undefined)); // a blackholed Redis: no answer, no error
    const { helpers, inventoryCache } = build(del);
    const started = Date.now();
    await expect(helpers.afterStockChange(actor, [{ productId: 'p1', productStockAfter: '4' }] as never)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(inventoryCache.syncMany).toHaveBeenCalled();
  });
});

import type { Cache } from 'cache-manager';

/** Contract §6: analytics cache entries of a shop, dropped after any invoice mutation. */
export function analyticsCacheKeys(shopId: string): string[] {
  return ['dashboard', 'kpis', 'summary'].map((suffix) => `shop:${shopId}:analytics:${suffix}`);
}

/** Deletes every analytics cache entry of the shop. Throws if the cache store fails. */
export async function invalidateAnalyticsCache(cache: Pick<Cache, 'del'>, shopId: string): Promise<void> {
  for (const key of analyticsCacheKeys(shopId)) {
    await cache.del(key);
  }
}

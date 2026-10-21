import type { Cache } from 'cache-manager';

/** Contract §6: analytics cache entries of a shop, dropped after any invoice mutation. */
export function analyticsCacheKeys(shopId: string): string[] {
  return ['dashboard', 'kpis', 'summary', 'allTime'].map((suffix) => `shop:${shopId}:analytics:${suffix}`);
}

/**
 * How long a request waits for the analytics invalidation after its commit
 * (audit R3): the sale is committed, so a slow or blackholed Redis may cost
 * the cashier at most this, never the whole response. The entries carry
 * short TTLs (60 s KPIs) and the outbox processor invalidates again.
 */
export const CACHE_INVALIDATION_BUDGET_MS = 1_000;

/** The invalidation did not finish within its budget (the cache is advisory: callers log it). */
export class CacheInvalidationTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`analytics cache invalidation did not finish within ${budgetMs} ms`);
    this.name = 'CacheInvalidationTimeoutError';
  }
}

/**
 * Deletes every analytics cache entry of the shop in one round trip
 * (`mdel`), bounded by `budgetMs`. Rejects when the store fails or the
 * budget runs out; a caller on a request path catches and logs, never fails
 * the request it follows.
 */
export async function invalidateAnalyticsCache(
  cache: Pick<Cache, 'mdel'>,
  shopId: string,
  budgetMs: number = CACHE_INVALIDATION_BUDGET_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const work = cache.mdel(analyticsCacheKeys(shopId));
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CacheInvalidationTimeoutError(budgetMs)), budgetMs);
  });
  try {
    await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
    // The abandoned delete may still settle later; its outcome is of no interest.
    work.catch(() => undefined);
  }
}

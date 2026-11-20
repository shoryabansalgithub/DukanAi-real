import { Prisma } from '@prisma/client';
import { TenantContext } from './tenant-context.interface';
import { TenantContextService } from './tenant-context.service';

/**
 * Tenant context for background work (roadmap 1.4, 4.1). A BullMQ job or a
 * scheduled sweep runs outside any HTTP request, so the Prisma tenant
 * extension has no shop to scope by and refuses every tenant-model query
 * ("Missing tenant context"). Every processor therefore runs its handler
 * under one of these:
 *   - `jobContext(shopId, jobId)` when the job data names the shop;
 *   - `runInShopOf(...)` when the job only names a document: the document's
 *     shop is read as the system tenant and the handler runs in that shop;
 *   - `runAsSuperAdmin` for work that legitimately spans shops (relays).
 * `src/iam/tenant-context/processor-context.spec.ts` scans every processor
 * source and fails when a `process` method establishes none of them.
 */
export function jobContext(shopId: string, jobId: string | number | undefined, correlationId?: string): TenantContext {
  const id = `job-${jobId ?? 'unknown'}`;
  return { shopId, correlationId: correlationId ?? id, requestId: id };
}

/** A job whose data must name its shop; refused loudly instead of running unscoped. */
export function requireJobShop(data: { shopId?: unknown } | undefined, jobName: string): string {
  const shopId = data?.shopId;
  if (typeof shopId !== 'string' || shopId.length === 0) {
    throw new Error(`Job ${jobName} carries no shopId; refusing to run outside a tenant context.`);
  }
  return shopId;
}

type ShopLookup = { findUnique(args: { where: { id: string }; select: { shopId: true } }): Promise<{ shopId: string | null } | null> };

/**
 * Runs `fn` in the tenant context of the shop that owns `model` row `id`.
 * The owner is read as the system tenant (the only query that may run
 * unscoped); a missing row resolves to `undefined` without calling `fn`,
 * so a job for a deleted document is a no-op rather than a crash loop.
 */
export async function runInShopOf<T>(
  tenant: TenantContextService,
  db: Record<string, unknown>,
  model: Uncapitalize<Prisma.ModelName>,
  id: string,
  jobId: string | number | undefined,
  fn: (shopId: string) => Promise<T>,
): Promise<T | undefined> {
  const delegate = db[model] as ShopLookup | undefined;
  if (!delegate) throw new Error(`runInShopOf: unknown model ${model}`);
  // Awaited inside the scope: a Prisma promise is lazy, so returning it bare would run the query outside it.
  const row = await tenant.runAsSuperAdmin(async () => await delegate.findUnique({ where: { id }, select: { shopId: true } }));
  if (!row?.shopId) return undefined;
  const shopId = row.shopId;
  return tenant.runWithContext(jobContext(shopId, jobId), () => fn(shopId));
}

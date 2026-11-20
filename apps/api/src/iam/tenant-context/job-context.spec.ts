import { TenantContextService } from './tenant-context.service';
import { runInShopOf } from './job-context';

/**
 * A Prisma query is a lazy promise: it runs when awaited, in whatever
 * AsyncLocalStorage scope is current then. The fake delegate below behaves
 * the same way, so a lookup returned bare out of `runAsSuperAdmin` runs
 * without the system tenant and fails, exactly as the real extension does
 * ("Missing tenant context").
 */
describe('runInShopOf', () => {
  const tenant = new TenantContextService();
  const lazyLookup = (shopId: string | null) => ({
    findUnique: () => ({
      then: (resolve: (row: unknown) => void, reject: (error: Error) => void) => {
        if (!tenant.isSuperAdminBypass()) return reject(new Error('Missing tenant context for operation findUnique'));
        return resolve(shopId ? { shopId } : null);
      },
    }),
  });

  it('reads the owning shop as the system tenant and runs the job in that shop', async () => {
    const seen = await runInShopOf(tenant, { importJob: lazyLookup('shop-1') }, 'importJob', 'job-1', 7, async (shopId) => ({ shopId, context: tenant.getShopId() }));
    expect(seen).toEqual({ shopId: 'shop-1', context: 'shop-1' });
  });

  it('is a no-op for a document that no longer exists', async () => {
    const fn = jest.fn();
    await expect(runInShopOf(tenant, { importJob: lazyLookup(null) }, 'importJob', 'gone', 7, fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});

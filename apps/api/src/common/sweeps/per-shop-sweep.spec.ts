import { Logger } from '@nestjs/common';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SWEEP_PAGE_SIZE, sweepEveryShop } from './per-shop-sweep';

describe('sweepEveryShop', () => {
  const tenantContext = new TenantContextService();
  const prisma = { shop: { findMany: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) } } as unknown as PrismaService;
  const logger = { log: jest.fn(), error: jest.fn() } as unknown as Logger;

  it('visits every open shop inside its own tenant context and keeps going after a failure', async () => {
    const seen: Array<{ shopId: string; contextShop: string | undefined; bypass: boolean }> = [];
    const summary = await sweepEveryShop(prisma, tenantContext, logger, 'TestSweep', async (shopId) => {
      seen.push({ shopId, contextShop: tenantContext.context.shopId, bypass: tenantContext.isSuperAdminBypass() });
      if (shopId === 'b') throw new Error('boom');
      return 2;
    });

    expect(seen).toEqual([
      { shopId: 'a', contextShop: 'a', bypass: false },
      { shopId: 'b', contextShop: 'b', bypass: false },
      { shopId: 'c', contextShop: 'c', bypass: false },
    ]);
    expect(summary).toEqual({ shops: 3, affected: 4, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('shop b'));
  });

  it('lists shops as the system tenant and skips archived or deleted ones', async () => {
    await sweepEveryShop(prisma, tenantContext, logger, 'TestSweep', async () => 0);
    const call = (prisma.shop.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.status.in).toEqual(['ACTIVE', 'SUSPENDED', 'LOCKED']);
    expect(call).toMatchObject({ orderBy: { id: 'asc' }, take: SWEEP_PAGE_SIZE });
    expect(call.cursor).toBeUndefined();
  });

  it('pages through the shops by id cursor instead of loading every tenant at once', async () => {
    const ids = Array.from({ length: SWEEP_PAGE_SIZE * 2 + 1 }, (_, i) => `shop-${String(i).padStart(4, '0')}`);
    const findMany = jest.fn().mockImplementation(async ({ cursor, take }: { cursor?: { id: string }; take: number }) => {
      const from = cursor ? ids.indexOf(cursor.id) + 1 : 0;
      return ids.slice(from, from + take).map((id) => ({ id }));
    });
    const paged = { shop: { findMany } } as unknown as PrismaService;
    const seen: string[] = [];
    const summary = await sweepEveryShop(paged, tenantContext, logger, 'TestSweep', async (shopId) => {
      seen.push(shopId);
      return 1;
    });
    expect(seen).toEqual(ids);
    expect(summary).toEqual({ shops: ids.length, affected: ids.length, failed: 0 });
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: ids[SWEEP_PAGE_SIZE - 1] }, skip: 1 });
  });
});

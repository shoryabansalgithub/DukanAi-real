import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';

describe('CategoriesService.update (roadmap 5.7)', () => {
  const tx = { category: { update: jest.fn() }, $executeRaw: jest.fn(), $queryRaw: jest.fn() };
  const prisma = {
    category: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const tenantContext = { getShopId: () => 'shop-1' };
  let service: CategoriesService;
  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
    service = new CategoriesService(prisma as never, tenantContext as never);
  });

  it('moves a category and re-roots its whole subtree with one UPDATE, reading both rows FOR UPDATE inside the same transaction', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'cat-1', parentId: 'old-parent', path: '/root/old-parent/', depth: 2 }])
      .mockResolvedValueOnce([{ id: 'new-parent', parentId: null, path: '/', depth: 0 }]);
    tx.category.update.mockResolvedValue({ id: 'cat-1', path: '/new-parent/', depth: 1 });
    tx.$executeRaw.mockResolvedValue(7);

    const updated = await service.update('cat-1', { name: 'Drinks', parentId: 'new-parent' } as never);

    expect(updated).toEqual({ id: 'cat-1', path: '/new-parent/', depth: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toMatch(/FROM `Category`\s+WHERE `id` = \? AND `shopId` = \? AND `isDeleted` = 0 FOR UPDATE/);
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['cat-1', 'shop-1']);
    expect(tx.$queryRaw.mock.calls[1].slice(1)).toEqual(['new-parent', 'shop-1']);
    // Only the named columns are written, never the request body as a whole.
    expect(tx.category.update).toHaveBeenCalledWith({ where: { id: 'cat-1' }, data: { name: 'Drinks', parentId: 'new-parent', path: '/new-parent/', depth: 1 } });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...params] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = sql.join('?');
    expect(text).toMatch(/UPDATE `Category`/);
    expect(text).toMatch(/SET `path` = CONCAT\(\?, SUBSTRING\(`path`, CHAR_LENGTH\(\?\) \+ 1\)\)/);
    expect(text).toMatch(/`depth` = `depth` \+ \?/);
    // The row is stamped from the application clock, never the database's (roadmap 8.2).
    expect(text).toMatch(/`updatedAt` = \?/);
    expect(text).toMatch(/WHERE `shopId` = \?\s+AND `isDeleted` = 0\s+AND `path` LIKE \?/);
    // new prefix, old prefix, depth delta (1 - 2), updatedAt, shop, LIKE pattern on the old prefix
    expect(params).toEqual(['/new-parent/cat-1/', '/root/old-parent/cat-1/', -1, expect.any(Date), 'shop-1', '/root/old-parent/cat-1/%']);
    // Never one update per descendant, never a read outside the transaction.
    expect(prisma.category.findMany).not.toHaveBeenCalled();
    expect(prisma.category.findFirst).not.toHaveBeenCalled();
    expect(prisma.category.update).not.toHaveBeenCalled();
  });

  it('moves a category to the root when parentId is null', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'cat-1', parentId: 'p', path: '/p/', depth: 1 }]);
    tx.category.update.mockResolvedValue({ id: 'cat-1', path: '/', depth: 0 });
    tx.$executeRaw.mockResolvedValue(2);
    await service.update('cat-1', { name: 'x', parentId: null } as never);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.category.update).toHaveBeenCalledWith({ where: { id: 'cat-1' }, data: { name: 'x', parentId: null, path: '/', depth: 0 } });
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(['/cat-1/', '/p/cat-1/', -1, expect.any(Date), 'shop-1', '/p/cat-1/%']);
  });

  it('escapes LIKE wildcards in the prefix', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'c_1', parentId: null, path: '/', depth: 0 }])
      .mockResolvedValueOnce([{ id: 'p%', parentId: null, path: '/', depth: 0 }]);
    tx.category.update.mockResolvedValue({ id: 'c_1', path: '/p%/', depth: 1 });
    tx.$executeRaw.mockResolvedValue(0);
    await service.update('c_1', { name: 'x', parentId: 'p%' } as never);
    const params = tx.$executeRaw.mock.calls[0].slice(1);
    expect(params[5]).toBe('/c\\_1/%');
    expect(params[0]).toBe('/p%/c_1/');
  });

  it('refuses a self-parent before the transaction, a cycle and an unknown parent inside it, and a missing category', async () => {
    await expect(service.update('cat-1', { name: 'x', parentId: 'cat-1' } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'cat-1', parentId: null, path: '/', depth: 0 }])
      .mockResolvedValueOnce([{ id: 'child', parentId: 'cat-1', path: '/cat-1/', depth: 1 }]);
    await expect(service.update('cat-1', { name: 'x', parentId: 'child' } as never)).rejects.toBeInstanceOf(BadRequestException);

    tx.$queryRaw.mockResolvedValueOnce([{ id: 'cat-1', parentId: null, path: '/', depth: 0 }]).mockResolvedValueOnce([]);
    await expect(service.update('cat-1', { name: 'x', parentId: 'nope' } as never)).rejects.toBeInstanceOf(BadRequestException);

    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.update('gone', { name: 'x', parentId: 'p' } as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.category.update).not.toHaveBeenCalled();
  });

  it('a plain rename neither opens a transaction nor touches descendants; a same-parent move is a plain update in the transaction', async () => {
    prisma.category.findFirst.mockResolvedValueOnce({ id: 'cat-1', parentId: 'p', path: '/p/', depth: 1 });
    prisma.category.update.mockResolvedValue({ id: 'cat-1', name: 'Renamed' });
    await expect(service.update('cat-1', { name: 'Renamed' } as never)).resolves.toEqual({ id: 'cat-1', name: 'Renamed' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.category.update).toHaveBeenCalledWith({ where: { id: 'cat-1' }, data: { name: 'Renamed' } });

    tx.$queryRaw.mockResolvedValueOnce([{ id: 'cat-1', parentId: 'p', path: '/p/', depth: 1 }]);
    tx.category.update.mockResolvedValue({ id: 'cat-1' });
    await service.update('cat-1', { name: 'Same', parentId: 'p' } as never);
    expect(tx.category.update).toHaveBeenCalledWith({ where: { id: 'cat-1' }, data: { name: 'Same' } });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

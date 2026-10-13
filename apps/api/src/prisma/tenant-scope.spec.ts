import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GLOBAL_MODELS, TENANT_MODELS, isTenantModel, scopeTenantArgs } from './tenant-scope';

describe('tenant scope (derived from the Prisma schema)', () => {
  const A = 'shop-a';
  const B = 'shop-b';

  it('scopes every model that carries shopId, except the documented global ones', () => {
    const withShopId = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'shopId')).map((m) => m.name);
    expect(withShopId.length).toBeGreaterThan(150);
    for (const name of withShopId) expect(isTenantModel(name)).toBe(!GLOBAL_MODELS.has(name));
    expect(TENANT_MODELS.has('Shop')).toBe(false);
    expect(TENANT_MODELS.has('RefreshToken')).toBe(false);
    expect([...GLOBAL_MODELS].sort()).toEqual(['Invitation', 'User']);
  });

  describe('top-level filters', () => {
    it.each(['findUnique', 'findFirst', 'findMany', 'update', 'updateMany', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy'])(
      'adds shopId to the where of %s',
      (operation) => {
        expect(scopeTenantArgs('Product', operation, { where: { id: 'p1' } }, A)).toMatchObject({ where: { id: 'p1', shopId: A } });
        expect(scopeTenantArgs('Product', operation, {}, A)).toMatchObject({ where: { shopId: A } });
      },
    );

    it('refuses a where that names another shop', () => {
      expect(() => scopeTenantArgs('Product', 'findMany', { where: { shopId: B } }, A)).toThrow(ForbiddenException);
    });

    it('leaves global and shop-less models alone', () => {
      expect(scopeTenantArgs('User', 'findUnique', { where: { id: 'u1' } }, A)).toEqual({ where: { id: 'u1' } });
      expect(scopeTenantArgs('Shop', 'findUnique', { where: { id: B } }, A)).toEqual({ where: { id: B } });
    });
  });

  describe('creates', () => {
    it('binds a create to the caller shop and refuses another shopId', () => {
      expect(scopeTenantArgs('Product', 'create', { data: { name: 'x' } }, A)).toMatchObject({ data: { name: 'x', shopId: A } });
      expect(() => scopeTenantArgs('Product', 'create', { data: { name: 'x', shopId: B } }, A)).toThrow(ForbiddenException);
    });

    it('binds every row of createMany', () => {
      const args = scopeTenantArgs('Product', 'createMany', { data: [{ name: 'x' }, { name: 'y' }] }, A);
      expect(args.data).toEqual([
        { name: 'x', shopId: A },
        { name: 'y', shopId: A },
      ]);
    });

    it('accepts shop.connect to the own shop and refuses any other shop link', () => {
      expect(scopeTenantArgs('Product', 'create', { data: { name: 'x', shop: { connect: { id: A } } } }, A)).toMatchObject({
        data: { name: 'x', shop: { connect: { id: A } } },
      });
      expect(() => scopeTenantArgs('Product', 'create', { data: { shop: { connect: { id: B } } } }, A)).toThrow(ForbiddenException);
      expect(() => scopeTenantArgs('Product', 'create', { data: { shop: { create: { name: 'new' } } } }, A)).toThrow(ForbiddenException);
    });

    it('scopes the create side of an upsert', () => {
      const args = scopeTenantArgs('LedgerAccountBalance', 'upsert', { where: { shopId_account: { shopId: A, account: 'CASH' } }, create: { account: 'CASH', balance: 1 }, update: { balance: 1 } }, A);
      expect(args).toMatchObject({ where: { shopId: A }, create: { shopId: A } });
    });
  });

  describe('updates', () => {
    it('refuses moving a row to another shop and drops a redundant own shopId', () => {
      expect(() => scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { shopId: B } }, A)).toThrow(ForbiddenException);
      expect(scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { shopId: A, name: 'n' } }, A)).toMatchObject({ data: { name: 'n' } });
    });

    it('refuses updateMany that moves rows', () => {
      expect(() => scopeTenantArgs('Product', 'updateMany', { where: {}, data: { shopId: B } }, A)).toThrow(ForbiddenException);
    });
  });

  describe('nested writes', () => {
    it('narrows nested connect / set / disconnect / delete filters to the caller shop', () => {
      const args = scopeTenantArgs('Shop', 'update', { where: { id: A }, data: { products: { connect: [{ id: 'p-b' }], set: [{ id: 'p-c' }] } } }, A);
      expect(args).toMatchObject({ data: { products: { connect: [{ id: 'p-b', shopId: A }], set: [{ id: 'p-c', shopId: A }] } } });
      const single = scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { category: { connect: { id: 'cat-b' } } } }, A);
      expect(single).toMatchObject({ data: { category: { connect: { id: 'cat-b', shopId: A } } } });
      const bool = scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { category: { disconnect: true } } }, A);
      expect(bool).toMatchObject({ data: { category: { disconnect: true } } });
    });

    it('binds nested creates and createMany rows of tenant models', () => {
      const args = scopeTenantArgs('Invoice', 'create', { data: { invoiceNumber: 'I', udharTransactions: { create: [{ amount: 1 }] }, payments: { createMany: { data: [{ amount: 1 }] } } } }, A);
      expect(args).toMatchObject({
        data: { shopId: A, udharTransactions: { create: [{ amount: 1, shopId: A }] }, payments: { createMany: { data: [{ amount: 1, shopId: A }] } } },
      });
    });

    it('scopes nested update, updateMany, upsert, deleteMany and connectOrCreate', () => {
      const args = scopeTenantArgs(
        'Shop',
        'update',
        {
          where: { id: A },
          data: {
            products: {
              update: [{ where: { id: 'p1' }, data: { name: 'n', shopId: A } }],
              updateMany: { where: { isActive: false }, data: { isActive: true } },
              upsert: [{ where: { id: 'p2' }, create: { name: 'c' }, update: { name: 'u' } }],
              deleteMany: { isDeleted: true },
              connectOrCreate: { where: { id: 'p3' }, create: { name: 'c3' } },
            },
          },
        },
        A,
      );
      expect(args).toMatchObject({
        data: {
          products: {
            update: [{ where: { id: 'p1', shopId: A }, data: { name: 'n' } }],
            updateMany: { where: { isActive: false, shopId: A }, data: { isActive: true } },
            upsert: [{ where: { id: 'p2', shopId: A }, create: { name: 'c', shopId: A }, update: { name: 'u' } }],
            deleteMany: [{ isDeleted: true, shopId: A }],
            connectOrCreate: { where: { id: 'p3', shopId: A }, create: { name: 'c3', shopId: A } },
          },
        },
      });
    });

    it('scopes a to-one nested update written in shorthand', () => {
      const args = scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { category: { update: { name: 'renamed' } } } }, A);
      expect(args).toMatchObject({ data: { category: { update: { name: 'renamed' } } } });
      expect(() => scopeTenantArgs('Product', 'update', { where: { id: 'p1' }, data: { category: { update: { shopId: B } } } }, A)).toThrow(ForbiddenException);
    });

    it('refuses nested writes that link another shop through any Shop relation', () => {
      expect(() => scopeTenantArgs('User', 'update', { where: { id: 'u1' }, data: { ownedShop: { connect: { id: B } } } }, A)).toThrow(ForbiddenException);
      expect(scopeTenantArgs('User', 'update', { where: { id: 'u1' }, data: { ownedShop: { connect: { id: A } } } }, A)).toMatchObject({
        data: { ownedShop: { connect: { id: A } } },
      });
    });
  });
});

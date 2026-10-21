import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ShopStatus } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator';
import { IS_SKIP_TENANT_KEY } from '../decorators/skip-tenant.decorator';
import { TenantGuard } from './tenant.guard';

describe('TenantGuard', () => {
  const build = (metadata: Record<string, unknown>, user?: { id: string; email: string; shopId?: string; shopStatus?: ShopStatus }) => {
    const reflector = { getAllAndOverride: jest.fn((key: string) => metadata[key]) } as unknown as Reflector;
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    return () => new TenantGuard(reflector).canActivate(context);
  };
  const user = (shopStatus?: ShopStatus, shopId?: string | null) => ({ id: 'u1', email: 'u@test.local', shopId: shopId === null ? undefined : (shopId ?? 'shop-1'), shopStatus });

  it('lets an ACTIVE shop through', () => {
    expect(build({}, user(ShopStatus.ACTIVE))()).toBe(true);
  });

  it.each([ShopStatus.SUSPENDED, ShopStatus.LOCKED, ShopStatus.ARCHIVED, ShopStatus.DELETED])('refuses a %s shop', (status) => {
    expect(build({}, user(status))).toThrow(ForbiddenException);
  });

  it('fails closed when the shop status is unknown', () => {
    expect(build({}, user(undefined))).toThrow(ForbiddenException);
  });

  it('refuses a user without a shop', () => {
    expect(build({}, user(ShopStatus.ACTIVE, null))).toThrow(ForbiddenException);
  });

  it('skips public and tenant-less routes, and leaves a missing user to the auth guard', () => {
    expect(build({ [IS_PUBLIC_KEY]: true })()).toBe(true);
    expect(build({ [IS_SKIP_TENANT_KEY]: true }, user(ShopStatus.SUSPENDED))()).toBe(true);
    expect(build({}, undefined)()).toBe(true);
  });
});

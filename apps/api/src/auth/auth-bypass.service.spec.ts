import { AuthBypassService, SYSTEM_USER_EMAIL } from './auth-bypass.service';
import { AuthConfig } from '../config/domains/auth.config';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthBypassService', () => {
  const systemUserRecord = {
    id: 'user-1',
    email: SYSTEM_USER_EMAIL,
    name: 'System User',
    phone: null,
    role: 'OWNER',
    isActive: true,
    shopId: 'shop-1',
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    shop: { status: 'ACTIVE' },
  };

  function build(flagValue: unknown) {
    // AuthConfig has already coerced the raw env value to a real boolean by the
    // time the service sees it (see parseAuthDisabled). The service only ever
    // treats a strict boolean `true` as enabled.
    const authConfig = { authDisabled: flagValue } as unknown as AuthConfig;
    const prisma = {
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new AuthBypassService(authConfig, prisma as unknown as PrismaService);
    return { service, prisma };
  }

  describe('isEnabled — never in production', () => {
    it('stays false under NODE_ENV=production even when the config says true', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(build(true).service.isEnabled).toBe(false);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  describe('isEnabled — secure by default', () => {
    it('is disabled when the flag is unset', () => {
      expect(build(undefined).service.isEnabled).toBe(false);
    });

    it('is disabled when the flag is false', () => {
      expect(build(false).service.isEnabled).toBe(false);
    });

    it('is NOT enabled by merely truthy non-boolean values', () => {
      // The config layer converts recognized tokens to a real boolean before
      // the service sees them; anything else must not activate the bypass.
      expect(build('true').service.isEnabled).toBe(false);
      expect(build(1).service.isEnabled).toBe(false);
    });

    it('is enabled only for boolean true', () => {
      expect(build(true).service.isEnabled).toBe(true);
    });
  });

  describe('getSystemUser', () => {
    it('returns the existing system user without provisioning', async () => {
      const { service, prisma } = build(true);
      prisma.user.findUnique.mockResolvedValue(systemUserRecord);

      const user = await service.getSystemUser();

      expect(user.email).toBe(SYSTEM_USER_EMAIL);
      expect(user.shopId).toBe('shop-1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('provisions a shop and OWNER user on first use when missing', async () => {
      const { service, prisma } = build(true);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          $executeRawUnsafe: jest.fn().mockResolvedValue(0),
          shop: { create: jest.fn().mockResolvedValue({ id: 'shop-1' }) },
          user: { create: jest.fn().mockResolvedValue(systemUserRecord) },
        }),
      );

      const user = await service.getSystemUser();

      expect(user.email).toBe(SYSTEM_USER_EMAIL);
      expect(user.role).toBe('OWNER');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('caches the system user after the first lookup', async () => {
      const { service, prisma } = build(true);
      prisma.user.findUnique.mockResolvedValue(systemUserRecord);

      await service.getSystemUser();
      await service.getSystemUser();

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});

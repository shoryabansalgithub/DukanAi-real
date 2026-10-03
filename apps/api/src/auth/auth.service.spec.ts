import { UnauthorizedException } from '@nestjs/common';
import { Role, ShopStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';

const user: SafeUserDto = {
  id: 'user-1', email: 'owner@example.com', name: 'Owner', role: Role.OWNER,
  phone: null, isActive: true, shopId: 'shop-1', shopStatus: ShopStatus.ACTIVE, tokenVersion: 0,
  createdAt: new Date(), updatedAt: new Date(),
};

const DAY = 86_400_000;

function build() {
  const usersService = {
    findSafeById: jest.fn(),
    findByEmailWithPassword: jest.fn(),
    incrementFailedAttempts: jest.fn(),
    resetFailedAttempts: jest.fn(),
    isLockedNow: jest.fn(),
  };
  const jwtService = { sign: jest.fn().mockReturnValue('access-token') };
  const tx = {
    refreshToken: { create: jest.fn(), updateMany: jest.fn() },
    user: { update: jest.fn() },
  };
  const prisma = {
    refreshToken: { create: tx.refreshToken.create, findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { update: jest.fn() },
    // Interactive transactions run the callback against `tx`; array transactions just resolve.
    $transaction: jest.fn().mockImplementation((arg: unknown) => (typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : Promise.resolve([]))),
  };
  const sockets = { disconnectUser: jest.fn() };
  const jwtConfig = { jwtRefreshExpiresIn: '7d', sessionAbsoluteLifetime: '30d', jwtExpiresIn: '15m' };
  const service = new AuthService(usersService as any, jwtService as any, prisma as any, sockets as any, jwtConfig as any);
  return { service, usersService, jwtService, prisma, tx, sockets };
}

const liveSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'refresh-1', userId: user.id, familyId: 'family-1', isRevoked: false, rotatedAt: null,
  expiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() + 30 * DAY), ...overrides,
});

describe('AuthService sessions', () => {
  it('login opens a family: the refresh token is stored hashed with idle and absolute expiries, the access token carries the family id', async () => {
    const { service, jwtService, tx } = build();
    const before = Date.now();

    const result = await service.login(user, '127.0.0.1', 'x'.repeat(300));

    expect(result.access_token).toBe('access-token');
    expect(result.refresh_token).toHaveLength(80);
    const created = tx.refreshToken.create.mock.calls[0][0].data;
    expect(created.token).not.toContain(result.refresh_token);
    expect(created.token).toHaveLength(64);
    expect(created.userId).toBe(user.id);
    expect(created.familyId).toBeDefined();
    expect(created.userAgent).toHaveLength(191);
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(created.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(jwtService.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: user.id, sid: created.familyId, tokenVersion: 0 }));
  });

  it('refresh consumes the presented token conditionally and issues a successor in the same family, capped by the absolute expiry', async () => {
    const { service, prisma, tx, usersService, jwtService } = build();
    const session = liveSession({ absoluteExpiresAt: new Date(Date.now() + DAY / 2) });
    prisma.refreshToken.findUnique.mockResolvedValue(session);
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    usersService.findSafeById.mockResolvedValue(user);

    const result = await service.refresh('a'.repeat(80), '127.0.0.1', 'jest');

    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'refresh-1', isRevoked: false, rotatedAt: null },
      data: { isRevoked: true, rotatedAt: expect.any(Date) },
    });
    const created = tx.refreshToken.create.mock.calls[0][0].data;
    expect(created.familyId).toBe('family-1');
    expect(created.expiresAt.getTime()).toBe(session.absoluteExpiresAt.getTime()); // idle lifetime never outlives the family
    expect(result.refresh_token).toHaveLength(80);
    expect(jwtService.sign).toHaveBeenCalledWith(expect.objectContaining({ sid: 'family-1' }));
  });

  it('a token already consumed by rotation is reuse: the family is revoked, tokenVersion bumped, sockets dropped', async () => {
    const { service, prisma, sockets } = build();
    prisma.refreshToken.findUnique.mockResolvedValue(liveSession({ isRevoked: true, rotatedAt: new Date() }));

    await expect(service.refresh('a'.repeat(80))).rejects.toThrow(/reuse detected/);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    expect(sockets.disconnectUser).toHaveBeenCalledWith(user.id, expect.stringContaining('reuse'));
  });

  it('losing the consume race (count 0) is treated as reuse too', async () => {
    const { service, prisma, tx, usersService } = build();
    prisma.refreshToken.findUnique.mockResolvedValue(liveSession());
    usersService.findSafeById.mockResolvedValue(user);
    tx.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh('a'.repeat(80))).rejects.toThrow(/reuse detected/);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['revoked by logout', liveSession({ isRevoked: true })],
    ['idle-expired', liveSession({ expiresAt: new Date(Date.now() - 1) })],
    ['past the absolute lifetime', liveSession({ absoluteExpiresAt: new Date(Date.now() - 1) })],
  ])('rejects a %s refresh token without escalating', async (_label, session) => {
    const { service, prisma, tx } = build();
    prisma.refreshToken.findUnique.mockResolvedValue(session);

    await expect(service.refresh('a'.repeat(80))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('logout revokes the live tokens of that family only', async () => {
    const { service, prisma } = build();
    await service.logout(user.id, 'family-1');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: user.id, familyId: 'family-1', isRevoked: false }, data: { isRevoked: true } });
  });

  it('isSessionActive asks for a live, unexpired token of the family', async () => {
    const { service, prisma } = build();
    prisma.refreshToken.findFirst.mockResolvedValueOnce({ id: 'x' }).mockResolvedValueOnce(null);
    await expect(service.isSessionActive(user.id, 'family-1')).resolves.toBe(true);
    await expect(service.isSessionActive(user.id, 'family-1')).resolves.toBe(false);
    expect(prisma.refreshToken.findFirst.mock.calls[0][0].where).toMatchObject({ userId: user.id, familyId: 'family-1', isRevoked: false });
  });
});

describe('AuthService.validateUser lockout', () => {
  const usersService = {
    findSafeById: jest.fn(),
    findByEmailWithPassword: jest.fn(),
    incrementFailedAttempts: jest.fn(),
    resetFailedAttempts: jest.fn(),
    isLockedNow: jest.fn(),
  };
  const service = new AuthService(usersService as any, {} as any, {} as any, {} as any, {} as any);
  const record = { id: 'user-1', password: '$2b$04$invalidhashinvalidhashinvalidhashinvalidhashinvalidha', isDeleted: false, isActive: true, isLocked: true, lockedUntil: new Date() };

  beforeEach(() => jest.clearAllMocks());

  it('refuses a new login while the lock is in force, without counting another failure', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(record);
    usersService.isLockedNow.mockResolvedValue(true);

    await expect(service.validateUser('owner@example.com', 'whatever')).resolves.toBeNull();
    expect(usersService.incrementFailedAttempts).not.toHaveBeenCalled();
  });

  it('checks the password again once the lock has expired (the service clears it)', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(record);
    usersService.isLockedNow.mockResolvedValue(false);

    await expect(service.validateUser('owner@example.com', 'wrong')).resolves.toBeNull();
    expect(usersService.isLockedNow).toHaveBeenCalledWith(record);
    expect(usersService.incrementFailedAttempts).toHaveBeenCalledWith('user-1');
  });
});

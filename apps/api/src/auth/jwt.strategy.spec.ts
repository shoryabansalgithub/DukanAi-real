import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtConfig } from '../config/domains/jwt.config';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy.validate', () => {
  const payload = { sub: 'u1', email: 'u@test.local', role: Role.CASHIER, shopId: 's1', tokenVersion: 0, sid: 'family-1' };
  const record = {
    id: 'u1', email: 'u@test.local', name: 'U', phone: null, role: Role.CASHIER, isActive: true, shopId: 's1',
    tokenVersion: 0, isDeleted: false, isLocked: false, lockedUntil: null, password: 'hash',
    createdAt: new Date(), updatedAt: new Date(), shop: { status: 'ACTIVE' },
  };
  const build = (user: Record<string, unknown> | null, sessionActive = true) => {
    const usersService = { findByIdWithSecurity: jest.fn().mockResolvedValue(user) } as unknown as UsersService;
    const authService = { isSessionActive: jest.fn().mockResolvedValue(sessionActive) } as unknown as AuthService;
    const jwtConfig = Object.assign(new JwtConfig(), { jwtSecret: 's'.repeat(32), jwtExpiresIn: '15m', jwtRefreshExpiresIn: '7d' });
    return { strategy: new JwtStrategy(jwtConfig, usersService, authService), authService };
  };

  it('keeps a session open while a brute-force lock is in force (the lock blocks new logins only)', async () => {
    const { strategy } = build({ ...record, isLocked: true, lockedUntil: new Date(Date.now() + 15 * 60_000), failedAttempts: 5 });
    await expect(strategy.validate(payload)).resolves.toMatchObject({ id: 'u1', email: 'u@test.local', sessionId: 'family-1' });
  });

  it('checks the session family named by the token and rejects one that has ended', async () => {
    const { strategy, authService } = build(record, false);
    await expect(strategy.validate(payload)).rejects.toThrow('Session has ended');
    expect(authService.isSessionActive).toHaveBeenCalledWith('u1', 'family-1');
  });

  it('rejects a token that names no session', async () => {
    const { strategy } = build(record);
    await expect(strategy.validate({ ...payload, sid: undefined })).rejects.toThrow('Token carries no session');
  });

  it.each([
    ['a deleted account', { isDeleted: true }],
    ['a deactivated account', { isActive: false }],
    ['a revoked token version', { tokenVersion: 1 }],
  ])('still rejects %s', async (_label, overrides) => {
    await expect(build({ ...record, ...overrides }).strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a user that no longer exists', async () => {
    await expect(build(null).strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });
});

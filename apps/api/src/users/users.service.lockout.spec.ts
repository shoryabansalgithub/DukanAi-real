import { SecurityConfig } from '../config/domains/security.config';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService login lockout', () => {
  const security = Object.assign(new SecurityConfig(), { maxLoginAttempts: 3, lockoutDurationMs: 60_000 });
  const build = () => {
    const prisma = { user: { update: jest.fn(), updateMany: jest.fn() } };
    const service = new UsersService(prisma as unknown as PrismaService, security);
    return { prisma, service };
  };

  it('counts a failure with an atomic increment and does not lock below the limit', async () => {
    const { prisma, service } = build();
    prisma.user.update.mockResolvedValue({ failedAttempts: 2 });

    await service.incrementFailedAttempts('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('locks the account for the configured duration once the limit is reached', async () => {
    const { prisma, service } = build();
    prisma.user.update.mockResolvedValue({ failedAttempts: 3 });
    const before = Date.now();

    await service.incrementFailedAttempts('u1');

    const call = prisma.user.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'u1', isLocked: false });
    expect(call.data.isLocked).toBe(true);
    expect(call.data.lockedUntil.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('treats an expired lock as over: clears it and the counter', async () => {
    const { prisma, service } = build();
    const expired = { id: 'u1', isLocked: true, lockedUntil: new Date(Date.now() - 1) };

    await expect(service.isLockedNow(expired)).resolves.toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedAttempts: 0, isLocked: false, lockedUntil: null } });
  });

  it('keeps a live lock and an unlocked account as they are', async () => {
    const { prisma, service } = build();

    await expect(service.isLockedNow({ id: 'u1', isLocked: true, lockedUntil: new Date(Date.now() + 60_000) })).resolves.toBe(true);
    await expect(service.isLockedNow({ id: 'u1', isLocked: false, lockedUntil: null })).resolves.toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

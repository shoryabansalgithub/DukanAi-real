import { ConflictException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SecurityConfig } from '../config/domains/security.config';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService.findOrCreateGoogleUser', () => {
  const record = {
    id: 'u1', email: 'owner@example.com', name: 'Owner', phone: null, role: Role.OWNER, isActive: true, shopId: 's1',
    tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
  };
  const build = () => {
    const tx = { shop: { create: jest.fn(), update: jest.fn() }, user: { create: jest.fn().mockResolvedValue(record) } };
    const prisma = {
      user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
    };
    return { service: new UsersService(prisma as unknown as PrismaService, new SecurityConfig()), prisma, tx };
  };

  it('returns the user already linked to this Google account', async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValue(record);
    await expect(service.findOrCreateGoogleUser('g-1', 'owner@example.com', 'Owner')).resolves.toMatchObject({ id: 'u1' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('never links an existing account that was not created through Google', async () => {
    const { service, prisma, tx } = build();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

    await expect(service.findOrCreateGoogleUser('g-1', 'owner@example.com', 'Owner')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('creates a new owner with a shop when the email is unknown', async () => {
    const { service, prisma, tx } = build();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.findOrCreateGoogleUser('g-1', 'owner@example.com', 'Owner')).resolves.toMatchObject({ id: 'u1' });
    expect(tx.shop.create).toHaveBeenCalled();
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({ googleId: 'g-1', role: Role.OWNER });
  });
});

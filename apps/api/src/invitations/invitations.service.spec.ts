import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EmailService } from '../common/email/email.service';
import { AppConfig } from '../config/domains/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from './invitations.service';

describe('InvitationsService', () => {
  const appConfig = Object.assign(new AppConfig(), { frontendUrl: 'https://app.example.com, https://pos.example.com' });

  function build(configured = true) {
    const tx = {
      shop: { findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Ravi Stores' }) },
      invitation: { create: jest.fn().mockResolvedValue({ id: 'inv-1', expiresAt: new Date('2026-10-01T00:00:00Z') }) },
    };
    const prisma = {
      invitation: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), delete: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
    };
    const email = { isConfigured: configured, send: jest.fn().mockResolvedValue(undefined) };
    const service = new InvitationsService(prisma as unknown as PrismaService, email as unknown as EmailService, appConfig);
    return { service, prisma, tx, email };
  }
  const owner = { id: 'owner-1', role: Role.OWNER };
  const manager = { id: 'mgr-1', role: Role.MANAGER };

  afterEach(() => {
    delete process.env.__NODE_ENV_BACKUP;
  });

  it('records the inviter, emails the token to the invitee and returns no token', async () => {
    const { service, tx, email } = build();

    const result = await service.generate('shop-1', manager, { email: 'New.Cashier@Example.com', role: Role.CASHIER });

    const created = tx.invitation.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ email: 'new.cashier@example.com', role: Role.CASHIER, shopId: 'shop-1', inviterId: 'mgr-1' });
    expect(created.token).toHaveLength(64); // sha256 of the raw token
    expect(email.send).toHaveBeenCalledTimes(1);
    const message = email.send.mock.calls[0][0];
    expect(message.to).toBe('new.cashier@example.com');
    expect(message.subject).toContain('Ravi Stores');
    expect(message.text).toMatch(/https:\/\/app\.example\.com\/register\?invite=[0-9a-f]{64}/);
    expect(message.text).not.toContain(created.token);
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/);
    expect(result).toMatchObject({ invitationId: 'inv-1', email: 'new.cashier@example.com', role: Role.CASHIER });
  });

  it.each([
    ['a MANAGER inviting a MANAGER', manager, Role.MANAGER],
    ['a MANAGER inviting an ADMIN', manager, Role.ADMIN],
    ['an ADMIN inviting an ADMIN', { id: 'a', role: Role.ADMIN }, Role.ADMIN],
  ])('refuses %s: the invited role must rank below the inviter', async (_label, actor, role) => {
    const { service, email } = build();
    await expect(service.generate('shop-1', actor, { email: 'x@example.com', role })).rejects.toBeInstanceOf(ForbiddenException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('never invites an OWNER or SUPER_ADMIN, whoever asks', async () => {
    const { service } = build();
    await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.OWNER })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.SUPER_ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to issue an invitation in production while email is not configured', async () => {
    const { service, tx } = build(false);
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.CASHIER })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(tx.invitation.create).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it('outside production an unconfigured mailer still lets the invitation through (the token is logged)', async () => {
    const { service, email } = build(false);
    await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.CASHIER })).resolves.toMatchObject({ invitationId: 'inv-1' });
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate invitation or an existing user', async () => {
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u' });
    await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.CASHIER })).rejects.toBeInstanceOf(ConflictException);
    prisma.invitation.findFirst.mockResolvedValueOnce({ id: 'inv-0' });
    await expect(service.generate('shop-1', owner, { email: 'x@example.com', role: Role.CASHIER })).rejects.toBeInstanceOf(ConflictException);
  });

  describe('revoke', () => {
    it('lets a MANAGER revoke only invitations they issued, and ADMIN roles revoke any', async () => {
      const { service, prisma } = build();
      prisma.invitation.findUnique.mockResolvedValue({ shopId: 'shop-1', isUsed: false, inviterId: 'someone-else' });

      await expect(service.revoke('shop-1', manager, 'inv-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.invitation.delete).not.toHaveBeenCalled();

      await expect(service.revoke('shop-1', owner, 'inv-1')).resolves.toMatchObject({ message: expect.stringContaining('revoked') });
      prisma.invitation.findUnique.mockResolvedValue({ shopId: 'shop-1', isUsed: false, inviterId: 'mgr-1' });
      await expect(service.revoke('shop-1', manager, 'inv-1')).resolves.toBeDefined();
      expect(prisma.invitation.delete).toHaveBeenCalledTimes(2);
    });

    it('answers 404 for another shop’s invitation', async () => {
      const { service, prisma } = build();
      prisma.invitation.findUnique.mockResolvedValue({ shopId: 'shop-2', isUsed: false, inviterId: 'owner-1' });
      await expect(service.revoke('shop-1', owner, 'inv-1')).rejects.toThrow('Invitation not found');
    });
  });
});

/**
 * Release-readiness audit (2026-10-11), auth and tenancy findings, over the
 * real stack: a reset link never reaches a lookalike address (P0-1), sign-in
 * accepts only the stored mailbox, the suspend body is validated (A7), a
 * removed or suspended user's invitations stop working (A8), an invitation
 * cannot be used to learn which addresses have accounts elsewhere (T6c),
 * clearing every notification is a management action (T6b), and a product
 * revision is found only under its own product and never approved by its
 * author (T6i).
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { EmailService, OutboundEmail } from '../../src/common/email/email.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FORGOT_PASSWORD_MESSAGE } from '../../src/auth/password-reset.service';
import { ProductVersioningService } from '../../src/product-versioning/product-versioning.service';
import { bootApp, createProduct, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

describe('Auth and tenancy hardening (audit 2026-10-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let A: TestShop;
  let B: TestShop;
  const outbox: OutboundEmail[] = [];
  const mailer = {
    isConfigured: false,
    send: async (message: OutboundEmail) => {
      outbox.push(message);
    },
  };
  const server = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(EmailService).useValue(mailer));
    prisma = app.get(PrismaService);
    A = await createShop(app, 'authA');
    B = await createShop(app, 'authB');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    outbox.length = 0;
  });

  describe('P0-1: lookalike addresses', () => {
    it('a reset requested for an accented lookalike of the address mails nothing and changes nothing', async () => {
      const lookalike = `owner-${A.suffix}@tést.local`;
      const res = await server().post('/api/auth/forgot-password').send({ email: lookalike });
      expect([res.status, res.body]).toEqual([200, { message: FORGOT_PASSWORD_MESSAGE }]);
      expect(outbox).toHaveLength(0);
      expect(await prisma.passwordResetToken.count({ where: { userId: A.ownerId } })).toBe(0);
    });

    it('the real address (any case) gets the link, sent to the address on the account', async () => {
      const stored = `owner-${A.suffix}@test.local`;
      const res = await server().post('/api/auth/forgot-password').send({ email: stored.toUpperCase() });
      expect(res.status).toBe(200);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe(stored);
    });

    it('sign-in with the right password under a lookalike address is refused', async () => {
      const user = await createUser(app, A, Role.MANAGER, 'Lookalike-Pass-77');
      const [local, domain] = user.email.split('@');
      const lookalike = `${local}@${domain.replace('test', 'tést')}`;
      expect((await server().post('/api/auth/login').send({ email: lookalike, password: 'Lookalike-Pass-77' })).status).toBe(401);
      expect((await server().post('/api/auth/login').send({ email: user.email.toUpperCase(), password: 'Lookalike-Pass-77' })).status).toBe(201);
    });

    it('registration stores the canonical (lower-case) address', async () => {
      const email = `New.Owner-${A.suffix}@Test.Local`;
      const res = await server().post('/api/auth/register').send({ email, password: 'Fresh-Owner-Pass-1', name: 'New Owner', shopName: `Shop ${A.suffix}` });
      expect(res.status).toBe(201);
      expect(res.body.email).toBe(email.toLowerCase());
    });
  });

  describe('A7 / A8: suspend and remove', () => {
    it('an empty suspend body is refused and changes nothing', async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const before = await tenantRunner(app).system(() => prisma.user.findUniqueOrThrow({ where: { id: A.cashierId } }));
      const res = await owner.patch(`/api/users/${A.cashierId}/suspend`).send({});
      expect(res.status).toBe(400);
      const after = await tenantRunner(app).system(() => prisma.user.findUniqueOrThrow({ where: { id: A.cashierId } }));
      expect([after.isActive, after.tokenVersion]).toEqual([before.isActive, before.tokenVersion]);
    });

    it("suspending or removing a manager voids the invitations they issued", async () => {
      const manager = await createUser(app, A, Role.MANAGER);
      const http = await httpAs(app, A, manager);
      expect((await http.post('/api/invitations/generate').send({ email: `inv1-${A.suffix}@test.local`, role: Role.CASHIER })).status).toBe(201);
      expect((await http.post('/api/invitations/generate').send({ email: `inv2-${A.suffix}@test.local`, role: Role.CASHIER })).status).toBe(201);
      expect(await prisma.invitation.count({ where: { inviterId: manager.id, isUsed: false } })).toBe(2);

      const owner = await httpAs(app, A, ownerOf(A));
      expect((await owner.patch(`/api/users/${manager.id}/suspend`).send({ isActive: false })).status).toBe(200);
      expect(await prisma.invitation.count({ where: { inviterId: manager.id, isUsed: false } })).toBe(0);

      const other = await createUser(app, A, Role.MANAGER);
      expect((await (await httpAs(app, A, other)).post('/api/invitations/generate').send({ email: `inv3-${A.suffix}@test.local`, role: Role.CASHIER })).status).toBe(201);
      expect((await owner.delete(`/api/users/${other.id}`)).status).toBe(200);
      expect(await prisma.invitation.count({ where: { inviterId: other.id, isUsed: false } })).toBe(0);
    });
  });

  describe('T6c: invitations do not reveal accounts in other shops', () => {
    it("inviting another shop's owner is answered like any invitation; a member of the inviter's own shop is named", async () => {
      const owner = await httpAs(app, A, ownerOf(A));
      const foreign = await owner.post('/api/invitations/generate').send({ email: `owner-${B.suffix}@test.local`, role: Role.CASHIER });
      expect(foreign.status).toBe(201);
      expect(foreign.body).toMatchObject({ message: 'Invitation sent' });

      const member = await owner.post('/api/invitations/generate').send({ email: `cashier-${A.suffix}@test.local`, role: Role.CASHIER });
      expect(member.status).toBe(409);
      expect(member.body.code).toBe('ALREADY_A_MEMBER');
    });
  });

  describe('T6b: notifications', () => {
    it('a cashier or viewer cannot clear every notification of the shop; a manager can', async () => {
      const cashier = await httpAs(app, A, await createUser(app, A, Role.CASHIER));
      const viewer = await httpAs(app, A, await createUser(app, A, Role.VIEWER));
      const manager = await httpAs(app, A, await createUser(app, A, Role.MANAGER));
      expect((await cashier.patch('/api/notifications/read-all').send({})).status).toBe(403);
      expect((await viewer.patch('/api/notifications/read-all').send({})).status).toBe(403);
      expect((await manager.patch('/api/notifications/read-all').send({})).status).toBe(200);
    });
  });

  describe('T6i: product revisions', () => {
    it('a revision is found only under its own product, and its author cannot approve it', async () => {
      const run = tenantRunner(app);
      const versioning = app.get(ProductVersioningService);
      const productX = await createProduct(app, A, { key: 'revX', gstRate: 'ZERO' });
      const productY = await createProduct(app, A, { key: 'revY', gstRate: 'ZERO' });
      const rev = await run.as(A.shopId, A.ownerId, Role.OWNER, () => versioning.createDraft(productX));
      const owner = await httpAs(app, A, ownerOf(A));

      expect((await owner.post(`/api/products/${productY}/revisions/${rev.id}/submit`).send({})).status).toBe(404);
      expect((await owner.post(`/api/products/${productX}/revisions/${rev.id}/submit`).send({})).status).toBe(201);
      const own = await owner.post(`/api/products/${productX}/revisions/${rev.id}/approve`).send({});
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('SEPARATION_OF_DUTIES');

      const admin = await httpAs(app, A, await createUser(app, A, Role.ADMIN));
      expect((await admin.post(`/api/products/${productY}/revisions/${rev.id}/approve`).send({})).status).toBe(404);
      expect((await admin.post(`/api/products/${productX}/revisions/${rev.id}/approve`).send({})).status).toBe(201);
    });
  });
});

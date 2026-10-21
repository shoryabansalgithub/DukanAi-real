/**
 * Roadmap 6.7 over the real stack: the forgot-password flow (token by email
 * only, single use, one hour, every session ended), the expenses month
 * summary computed over every expense of the shop, and a customer edit that
 * clears the email.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EmailService, OutboundEmail } from '../../src/common/email/email.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FORGOT_PASSWORD_MESSAGE } from '../../src/auth/password-reset.service';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { httpAs, issueTokens, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

describe('Web correctness details over HTTP (roadmap 6.7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let A: TestShop;
  let owner: Awaited<ReturnType<typeof httpAs>>;
  const outbox: OutboundEmail[] = [];
  const mailer = {
    isConfigured: false,
    send: async (message: OutboundEmail) => {
      outbox.push(message);
    },
  };

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(EmailService).useValue(mailer));
    prisma = app.get(PrismaService);
    A = await createShop(app, 'w67');
    owner = await httpAs(app, A, ownerOf(A));
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());
  const tokenIn = (mail: OutboundEmail): string => /reset-password\?token=([0-9a-f]{64})/.exec(mail.text)![1];

  describe('forgot password', () => {
    it('emails a single-use link, the reset changes the password and ends every session', async () => {
      const email = `owner-${A.suffix}@test.local`;
      const before = await issueTokens(app, ownerOf(A));
      expect((await server().get('/api/auth/profile').set('Authorization', `Bearer ${before.access_token}`)).status).toBe(200);

      const asked = await server().post('/api/auth/forgot-password').send({ email: email.toUpperCase() });
      expect(asked.status).toBe(200);
      expect(asked.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe(email);
      const token = tokenIn(outbox[0]);
      const stored = await prisma.passwordResetToken.findFirst({ where: { userId: A.ownerId, usedAt: null } });
      expect(stored?.tokenHash).not.toBe(token); // hashed at rest
      expect(stored!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);

      // A second request voids the first link.
      expect((await server().post('/api/auth/forgot-password').send({ email })).status).toBe(200);
      const second = tokenIn(outbox[1]);
      expect((await server().post('/api/auth/reset-password').send({ token, password: 'Fresh-Password-1' })).status).toBe(400);

      const reset = await server().post('/api/auth/reset-password').send({ token: second, password: 'Fresh-Password-1' });
      expect([reset.status, reset.body]).toEqual([200, expect.objectContaining({ message: expect.any(String) })]);
      // Single use.
      expect((await server().post('/api/auth/reset-password').send({ token: second, password: 'Another-Password-2' })).status).toBe(400);

      // The new password signs in; the old sessions are gone (tokenVersion bumped, refresh tokens revoked).
      const login = await server().post('/api/auth/login').send({ email, password: 'Fresh-Password-1' });
      expect(login.status).toBe(201);
      expect((await server().get('/api/auth/profile').set('Authorization', `Bearer ${before.access_token}`)).status).toBe(401);
      expect((await server().post('/api/auth/refresh').send({ refresh_token: before.refresh_token })).status).toBe(401);
    });

    it('never reveals whether an address exists and refuses a bad or expired token', async () => {
      const sent = outbox.length;
      const unknown = await server().post('/api/auth/forgot-password').send({ email: `nobody-${A.suffix}@test.local` });
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      expect(outbox).toHaveLength(sent);

      expect((await server().post('/api/auth/forgot-password').send({ email: 'not-an-email' })).status).toBe(400);
      expect((await server().post('/api/auth/reset-password').send({ token: 'short', password: 'Fresh-Password-1' })).status).toBe(400);
      expect((await server().post('/api/auth/reset-password').send({ token: 'a'.repeat(64), password: 'Fresh-Password-1' })).status).toBe(400);
      expect((await server().post('/api/auth/reset-password').send({ token: 'a'.repeat(64), password: 'short' })).status).toBe(400);

      // Expired: the row is aged in place.
      const email = `owner-${A.suffix}@test.local`;
      expect((await server().post('/api/auth/forgot-password').send({ email })).status).toBe(200);
      const token = tokenIn(outbox[outbox.length - 1]);
      await prisma.passwordResetToken.updateMany({ where: { userId: A.ownerId, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await server().post('/api/auth/reset-password').send({ token, password: 'Fresh-Password-3' });
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('PASSWORD_RESET_INVALID');
    });

    it('a Google-only account (no password) gets no link', async () => {
      const run = tenantRunner(app);
      const email = `google-${A.suffix}@test.local`;
      await run.system(() => prisma.user.create({ data: { email, name: 'Google User', role: 'CASHIER', password: null, googleId: `g-${A.suffix}`, shopId: A.shopId } }));
      const sent = outbox.length;
      expect((await server().post('/api/auth/forgot-password').send({ email })).status).toBe(200);
      expect(outbox).toHaveLength(sent);
    });
  });

  // The reset above ended every session of the owner: sign in again for the rest.
  describe('expenses summary', () => {
    beforeAll(async () => {
      owner = await httpAs(app, A, ownerOf(A));
    });

    it('this month and pending totals cover every expense, not the loaded page', async () => {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
      const post = (body: Record<string, unknown>) => owner.post('/api/expenses').send(body);
      expect((await post({ description: 'Rent', category: 'Rent', amount: 1000 })).status).toBe(201);
      expect((await post({ description: 'Tea', category: 'Supplies', amount: 40.5 })).status).toBe(201);
      expect((await post({ description: 'Old bill', category: 'Rent', amount: 999, expenseDate: lastMonth })).status).toBe(201);
      expect((await post({ description: 'Unpaid electricity', category: 'Utilities', amount: 300, isPaid: false })).status).toBe(201);
      expect((await post({ description: 'Unpaid old', category: 'Utilities', amount: 200, isPaid: false, expenseDate: lastMonth })).status).toBe(201);

      const res = await owner.get('/api/expenses/summary');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        month: expect.stringMatching(/^\d{4}-\d{2}$/),
        paidThisMonth: 1040.5,
        pendingTotal: 500,
        largestCategory: { category: 'Rent', amount: 1000 },
        countThisMonth: 3,
      });
    });
  });

  describe('customer edit', () => {
    it('an empty email clears the address; a malformed one is refused', async () => {
      const created = await owner.post('/api/customers').send({ name: 'Edit Me', phone: `6${A.suffix.replace(/\D/g, '').slice(-9).padStart(9, '3')}`, email: 'edit@example.com', city: 'Pune' });
      expect(created.status).toBe(201);
      const cleared = await owner.patch(`/api/customers/${created.body.id}`).send({ email: '', city: '' });
      expect([cleared.status, cleared.body]).toEqual([200, expect.anything()]);
      const read = await owner.get(`/api/customers/${created.body.id}`);
      expect(read.body.email ?? null).toBeNull();
      expect(read.body.city ?? null).toBeNull();
      expect((await owner.patch(`/api/customers/${created.body.id}`).send({ email: 'nope' })).status).toBe(400);
      expect((await owner.patch(`/api/customers/${created.body.id}`).send({ name: 'x'.repeat(101) })).status).toBe(400);
    });
  });
});

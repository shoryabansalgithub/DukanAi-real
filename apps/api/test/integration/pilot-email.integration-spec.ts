/**
 * Pilot pre-flight for email and Google sign-in (roadmap 9.19). The pilot
 * sends invitations and reset links through a real relay; here the API's own
 * transport (`SMTP_URL` -> nodemailer, the production path) delivers to a
 * local SMTP server, so the message the invitee opens is the one asserted:
 * sender, recipient, subject and a working link. A relay that refuses the
 * message leaves nothing behind that blocks the next attempt, and Google
 * sign-in on a server without a client id says so instead of failing as a
 * 500.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { FORGOT_PASSWORD_MESSAGE } from '../../src/auth/password-reset.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, tenantRunner, TestShop } from './pos-fixtures';
import { SmtpSink } from './smtp-sink';

jest.setTimeout(300_000);

const SENDER = 'Pilot Kirana <billing@pilotkirana.in>';
const PASSWORD = 'Pilot-Kirana-Counter-2026';

describe('pilot email and Google sign-in (roadmap 9.19)', () => {
  const sink = new SmtpSink();
  const saved = { SMTP_URL: process.env.SMTP_URL, EMAIL_FROM: process.env.EMAIL_FROM, GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID };
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let owner: Awaited<ReturnType<typeof httpAs>>;

  beforeAll(async () => {
    await sink.start();
    process.env.SMTP_URL = sink.url;
    process.env.EMAIL_FROM = SENDER;
    delete process.env.GOOGLE_CLIENT_ID;
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'p919');
    owner = await httpAs(app, A, ownerOf(A));
  });

  afterAll(async () => {
    await app?.close();
    await sink.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const server = () => request(app.getHttpServer());

  describe('invitations by email', () => {
    it('reach the invitee through the relay, and the link in the mail registers them', async () => {
      const email = `pilot-cashier-${A.suffix}@test.local`;
      const sent = await owner.post('/api/invitations/generate').send({ email, role: Role.CASHIER });
      expect(sent.status).toBe(201);

      const mail = await sink.waitFor((m) => m.to.includes(email));
      expect(mail.headers.from).toBe(SENDER);
      expect(mail.headers.to).toBe(email);
      expect(mail.headers.subject).toMatch(/^You're invited to .+ on DukaanAI$/);
      const token = /\/register\?invite=([0-9a-f]{64})/.exec(mail.text)?.[1];
      expect(token).toBeDefined();

      const accepted = await server().post('/api/invitations/accept').send({ token, name: 'Pilot Cashier', password: PASSWORD });
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({ email, role: Role.CASHIER });
      expect((await server().post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(201);
    });

    it('a relay that refuses the mail creates no invitation, so the next attempt is not blocked', async () => {
      const email = `pilot-refused-${A.suffix}@test.local`;
      sink.refuseRecipients = 'mailbox unavailable';
      try {
        const refused = await owner.post('/api/invitations/generate').send({ email, role: Role.CASHIER });
        expect(refused.status).toBe(502);
        expect(refused.body.code).toBe('INVITATION_EMAIL_FAILED');
        expect(await run.system(() => prisma.invitation.count({ where: { email } }))).toBe(0);
      } finally {
        sink.refuseRecipients = null;
      }

      const retried = await owner.post('/api/invitations/generate').send({ email, role: Role.CASHIER });
      expect(retried.status).toBe(201);
      await sink.waitFor((m) => m.to.includes(email));
    });
  });

  describe('forgot password by email', () => {
    it('the reset link reaches a password account through the relay and changes the password once', async () => {
      const email = ownerOf(A).email;
      const asked = await server().post('/api/auth/forgot-password').send({ email });
      expect(asked.status).toBe(200);
      expect(asked.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });

      const mail = await sink.waitFor((m) => m.to.includes(email) && m.headers.subject === 'Reset your DukaanAI password');
      expect(mail.headers.from).toBe(SENDER);
      const token = /\/reset-password\?token=([0-9a-f]{64})/.exec(mail.text)?.[1];
      expect(token).toBeDefined();

      expect((await server().post('/api/auth/reset-password').send({ token, password: PASSWORD })).status).toBe(200);
      expect((await server().post('/api/auth/reset-password').send({ token, password: `${PASSWORD}-again` })).status).toBe(400);
      expect((await server().post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(201);
    });

    it('a relay failure still answers the same message (no account oracle) and leaves no usable link', async () => {
      const shop = await createShop(app, 'p919r');
      const email = ownerOf(shop).email;
      sink.refuseRecipients = 'relay down';
      try {
        const asked = await server().post('/api/auth/forgot-password').send({ email });
        expect(asked.status).toBe(200);
        expect(asked.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      } finally {
        sink.refuseRecipients = null;
      }
      const live = await run.system(() => prisma.passwordResetToken.count({ where: { userId: shop.ownerId, usedAt: null } }));
      expect(live).toBe(0);
    });
  });

  describe('Google sign-in', () => {
    it('a server without GOOGLE_CLIENT_ID answers 503 GOOGLE_SIGNIN_NOT_CONFIGURED, not a 500', async () => {
      // A well-formed (unsigned) token: the DTO accepts the shape, the server must not get as far as Google.
      const idToken = ['{"alg":"RS256","typ":"JWT"}', '{"sub":"1","email":"pilot@example.com"}'].map((part) => Buffer.from(part).toString('base64url')).join('.') + '.c2ln';
      const res = await server().post('/api/auth/google').send({ idToken });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('GOOGLE_SIGNIN_NOT_CONFIGURED');
    });
  });
});

/**
 * Roadmap 2.8 (audit P1-8): an invitation can only grant a role below the
 * inviter's, records who issued it, reaches the invitee by email only (the
 * API response carries no token), and a MANAGER may revoke only their own.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { EmailService, OutboundEmail } from '../../src/common/email/email.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, TestShop } from './pos-fixtures';

describe('invitations (roadmap 2.8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let shop: TestShop;
  let other: TestShop;
  const outbox: OutboundEmail[] = [];
  const mailer = { isConfigured: true, send: jest.fn(async (m: OutboundEmail) => void outbox.push(m)) };

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(EmailService).useValue(mailer));
    prisma = app.get(PrismaService);
    shop = await createShop(app, 'invite');
    other = await createShop(app, 'invite-other');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    outbox.length = 0;
  });

  const tokenIn = (mail: OutboundEmail): string => /invite=([0-9a-f]{64})/.exec(mail.text)![1];

  it('an OWNER invites a MANAGER: the token goes to the invitee by email and the response has no token', async () => {
    const http = await httpAs(app, shop, ownerOf(shop));
    const email = `mgr-${shop.suffix}@test.local`;
    const res = await http.post('/api/invitations/generate').send({ email: email.toUpperCase(), role: Role.MANAGER });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ message: 'Invitation sent', email, role: Role.MANAGER });
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(email);
    const token = tokenIn(outbox[0]);
    const row = await prisma.invitation.findFirstOrThrow({ where: { email } });
    expect(row.inviterId).toBe(shop.ownerId);
    expect(row.token).not.toBe(token); // stored hashed

    const accepted = await request(app.getHttpServer()).post('/api/invitations/accept').send({ token, name: 'New Manager', password: 'Correct-Horse-9' });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ email, role: Role.MANAGER, shopId: shop.shopId });
    expect(accepted.body.password).toBeUndefined();
    expect((await request(app.getHttpServer()).post('/api/invitations/accept').send({ token, name: 'Again', password: 'Correct-Horse-9' })).status).toBe(400);
  });

  it('a MANAGER cannot invite a MANAGER or an ADMIN, only roles below their own', async () => {
    const manager = await createUser(app, shop, Role.MANAGER);
    const http = await httpAs(app, shop, manager);

    expect((await http.post('/api/invitations/generate').send({ email: `a-${shop.suffix}@test.local`, role: Role.ADMIN })).status).toBe(403);
    expect((await http.post('/api/invitations/generate').send({ email: `m-${shop.suffix}@test.local`, role: Role.MANAGER })).status).toBe(403);
    expect(outbox).toHaveLength(0);

    const cashier = await http.post('/api/invitations/generate').send({ email: `c-${shop.suffix}@test.local`, role: Role.CASHIER });
    expect(cashier.status).toBe(201);
    expect(outbox).toHaveLength(1);
  });

  it('a MANAGER revokes only their own invitations; an ADMIN role revokes any; another shop sees 404', async () => {
    const manager = await createUser(app, shop, Role.MANAGER);
    const otherManager = await createUser(app, shop, Role.MANAGER);
    const mine = await (await httpAs(app, shop, manager)).post('/api/invitations/generate').send({ email: `v1-${shop.suffix}@test.local`, role: Role.VIEWER });
    const theirs = await (await httpAs(app, shop, otherManager)).post('/api/invitations/generate').send({ email: `v2-${shop.suffix}@test.local`, role: Role.VIEWER });
    expect([mine.status, theirs.status]).toEqual([201, 201]);

    const asManager = await httpAs(app, shop, manager);
    expect((await asManager.delete(`/api/invitations/${theirs.body.invitationId}/revoke`)).status).toBe(403);
    expect((await asManager.delete(`/api/invitations/${mine.body.invitationId}/revoke`)).status).toBe(200);

    const foreign = await httpAs(app, other, ownerOf(other));
    expect((await foreign.delete(`/api/invitations/${theirs.body.invitationId}/revoke`)).status).toBe(404);
    expect((await (await httpAs(app, shop, ownerOf(shop))).delete(`/api/invitations/${theirs.body.invitationId}/revoke`)).status).toBe(200);
  });

  it('a CASHIER cannot invite at all, and a malformed accept is 400', async () => {
    const cashier = await createUser(app, shop, Role.CASHIER);
    expect((await (await httpAs(app, shop, cashier)).post('/api/invitations/generate').send({ email: `x-${shop.suffix}@test.local`, role: Role.VIEWER })).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/api/invitations/accept').send({ token: 'short', name: 'x', password: 'Correct-Horse-9' })).status).toBe(400);
    expect((await request(app.getHttpServer()).post('/api/invitations/accept').send({ token: 'f'.repeat(64), name: 'x', password: 'Correct-Horse-9' })).status).toBe(404);
  });
});

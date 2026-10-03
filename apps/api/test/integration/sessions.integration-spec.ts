/**
 * Roadmap 2.6 (audit P2-13, P2-14): sessions are refresh-token families.
 * Rotation consumes the presented token and issues a successor in the same
 * family; a consumed token presented again is reuse and ends every session of
 * the user; logout and the absolute lifetime end a family, and the access
 * tokens minted for it stop working at once because they carry its id.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createUser, httpAs, issueTokens, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, TestShop } from './pos-fixtures';

const PASSWORD = 'Correct-Horse-9';

describe('sessions: refresh-token families (roadmap 2.6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let shop: TestShop;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    shop = await createShop(app, 'sessions');
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();
  const login = (email: string, password = PASSWORD, userAgent = 'jest') =>
    request(server()).post('/api/auth/login').set('User-Agent', userAgent).send({ email, password });
  const refresh = (refresh_token: string) => request(server()).post('/api/auth/refresh').send({ refresh_token });
  const profile = (accessToken: string) => request(server()).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);
  const familiesOf = (userId: string) => prisma.refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  it('a login opens one family whose access token names it, and a refresh rotates within that family', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const first = await login(user.email);
    expect(first.status).toBe(201);
    expect((await profile(first.body.access_token)).status).toBe(200);

    const rotated = await refresh(first.body.refresh_token);
    expect(rotated.status).toBe(201);
    expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);

    const rows = await familiesOf(user.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows[0]).toMatchObject({ isRevoked: true });
    expect(rows[0].rotatedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ isRevoked: false, rotatedAt: null });
    expect(rows[1].absoluteExpiresAt.getTime()).toBe(rows[0].absoluteExpiresAt.getTime());

    // The family is still live, so the access token issued before the rotation keeps working until it expires.
    expect((await profile(first.body.access_token)).status).toBe(200);
    expect((await profile(rotated.body.access_token)).status).toBe(200);
  });

  it('presenting a consumed refresh token again ends every session of the user', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const phone = await login(user.email);
    const laptop = await login(user.email);
    const rotated = await refresh(phone.body.refresh_token);
    expect(rotated.status).toBe(201);

    const reuse = await refresh(phone.body.refresh_token);
    expect(reuse.status).toBe(401);
    expect(reuse.body.message).toMatch(/reuse detected/i);

    // The leaked family is revoked, tokenVersion is bumped: both devices are signed out.
    expect((await familiesOf(user.id)).every((r) => r.isRevoked)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { tokenVersion: true } })).tokenVersion).toBe(1);
    expect((await profile(rotated.body.access_token)).status).toBe(401);
    expect((await profile(laptop.body.access_token)).status).toBe(401);
    expect((await refresh(rotated.body.refresh_token)).status).toBe(401);
    expect((await refresh(laptop.body.refresh_token)).status).toBe(401);
  });

  it('logout ends the current family only: its access and refresh tokens stop at once, other sessions continue', async () => {
    const user = await createUser(app, shop, Role.MANAGER, PASSWORD);
    const phone = await login(user.email);
    const laptop = await login(user.email);

    const out = await request(server()).post('/api/auth/logout').set('Authorization', `Bearer ${phone.body.access_token}`);
    expect(out.status).toBe(200);

    expect((await profile(phone.body.access_token)).status).toBe(401);
    expect((await refresh(phone.body.refresh_token)).status).toBe(401);
    expect((await profile(laptop.body.access_token)).status).toBe(200);
    expect((await refresh(laptop.body.refresh_token)).status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { tokenVersion: true } })).tokenVersion).toBe(0);
  });

  it('revoking a listed session ends its whole family, other families continue', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const phone = await login(user.email);
    const laptop = await login(user.email);
    const rotated = await refresh(phone.body.refresh_token); // the phone family now has two rows, one live

    const sessions = await request(server()).get('/api/auth/sessions').set('Authorization', `Bearer ${laptop.body.access_token}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toHaveLength(2); // one live token per family
    const target = sessions.body[0] as { id: string; familyId: string };

    const revoked = await request(server()).delete(`/api/auth/sessions/${target.id}`).set('Authorization', `Bearer ${laptop.body.access_token}`);
    expect(revoked.status).toBe(200);
    const rows = await familiesOf(user.id);
    expect(rows.filter((r) => r.familyId === target.familyId).every((r) => r.isRevoked)).toBe(true);
    expect(rows.filter((r) => r.familyId !== target.familyId).some((r) => !r.isRevoked)).toBe(true);

    // Exactly the revoked family's access token is rejected; the other one still works.
    const statuses = [(await profile(rotated.body.access_token)).status, (await profile(laptop.body.access_token)).status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('a family past its absolute lifetime cannot refresh and its access tokens are rejected', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const session = await login(user.email);
    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });

    expect((await refresh(session.body.refresh_token)).status).toBe(401);
    expect((await profile(session.body.access_token)).status).toBe(401);
  });

  it('a refresh token that has idled past its own lifetime is refused without touching the family', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const session = await login(user.email);
    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await refresh(session.body.refresh_token)).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { tokenVersion: true } })).tokenVersion).toBe(0);
  });

  it('the refresh body is validated: a missing or malformed token is 400, never a 500', async () => {
    expect((await request(server()).post('/api/auth/refresh').send({})).status).toBe(400);
    expect((await request(server()).post('/api/auth/refresh').send({ refresh_token: 'not-a-token' })).status).toBe(400);
    expect((await request(server()).post('/api/auth/refresh').send({ refresh_token: 'f'.repeat(80), extra: 1 })).status).toBe(400);
    expect((await refresh('f'.repeat(80))).status).toBe(401);
  });

  it('a long User-Agent is stored truncated and the session lists it', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const ua = `Mozilla/5.0 ${'FBAN/FBIOS;'.repeat(30)}`;
    const session = await login(user.email, PASSWORD, ua);
    expect(session.status).toBe(201);
    const sessions = await request(server()).get('/api/auth/sessions').set('Authorization', `Bearer ${session.body.access_token}`);
    expect(sessions.body[0].userAgent).toHaveLength(191);
    expect(sessions.body[0].userAgent).toBe(ua.slice(0, 191));
  });

  it('access tokens signed without a session are refused, tokens from the fixtures are sessions', async () => {
    const http = await httpAs(app, shop, ownerOf(shop));
    expect((await http.get('/api/auth/profile')).status).toBe(200);
    const issued = await issueTokens(app, ownerOf(shop));
    expect((await refresh(issued.refresh_token)).status).toBe(201);

    const legacy = app.get(JwtService).sign({ sub: shop.ownerId, email: 'o', role: 'OWNER', shopId: shop.shopId, tokenVersion: 0 });
    expect((await profile(legacy)).status).toBe(401);
  });
});

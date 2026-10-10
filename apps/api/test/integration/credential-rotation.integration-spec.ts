/**
 * Secret rotation mechanics (roadmap 9.11) against the real database: what a
 * JWT_SECRET rotation does on its own (access tokens signed with the old
 * secret are refused, refresh tokens are NOT), and what the revoke-all
 * sessions tool adds (every live refresh token revoked, tokenVersion bumped,
 * so the old access token AND the refresh token are refused and a new login
 * works). The procedure in docs/SECRETS.md is the sum of the two.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AccessTokenPayload } from '../../src/auth/auth.service';
import { countSessions, revokeAllSessions } from '../../src/auth/session-revocation';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createUser } from '../security/security-fixtures';
import { bootApp, createShop, TestShop } from './pos-fixtures';

jest.setTimeout(120_000);
const PASSWORD = 'Correct-Horse-9';

describe('secret rotation mechanics (roadmap 9.11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let shop: TestShop;
  let other: TestShop;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    shop = await createShop(app, 'rot');
    other = await createShop(app, 'rotother');
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();
  const login = (email: string) => request(server()).post('/api/auth/login').send({ email, password: PASSWORD });
  const profile = (accessToken: string) => request(server()).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refresh_token: string) => request(server()).post('/api/auth/refresh').send({ refresh_token });

  it('an access token signed with another secret is refused, but a refresh token survives a secret change on its own', async () => {
    const user = await createUser(app, shop, Role.MANAGER, PASSWORD);
    const session = await login(user.email).expect(201);
    const { access_token, refresh_token } = session.body as { access_token: string; refresh_token: string };
    await profile(access_token).expect(200);

    // The same claims under a rotated JWT_SECRET: the API's verifier never accepts them.
    const payload = app.get(JwtService).decode(access_token) as AccessTokenPayload;
    const rotated = app.get(JwtService).sign(
      { email: payload.email, sub: payload.sub, role: payload.role, shopId: payload.shopId, tokenVersion: payload.tokenVersion, sid: payload.sid },
      { secret: 'rotated-secret-k9vP2xR7mQ4tW8zB1nL6cH3jF5dS0aY2' },
    );
    await profile(rotated).expect(401);

    // The opaque refresh token knows nothing about JWT_SECRET: it still mints a new pair.
    const renewed = await refresh(refresh_token).expect(201);
    expect(renewed.body.access_token).toBeTruthy();
    await profile(renewed.body.access_token as string).expect(200);
  });

  it('revoking one user ends that user everywhere and nobody else', async () => {
    const victim = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const bystander = await createUser(app, other, Role.CASHIER, PASSWORD);
    const a = (await login(victim.email).expect(201)).body as { access_token: string; refresh_token: string };
    const b = (await login(victim.email).expect(201)).body as { access_token: string; refresh_token: string };
    const c = (await login(bystander.email).expect(201)).body as { access_token: string; refresh_token: string };

    const dry = await countSessions(prisma, { userId: victim.id });
    expect(dry).toEqual({ usersBumped: 1, refreshTokensRevoked: 2 });
    const result = await revokeAllSessions(prisma, { userId: victim.id });
    expect(result).toEqual({ usersBumped: 1, refreshTokensRevoked: 2 });

    await profile(a.access_token).expect(401);
    await profile(b.access_token).expect(401);
    await refresh(a.refresh_token).expect(401);
    await refresh(b.refresh_token).expect(401);
    // The bystander is untouched, and the victim signs in again.
    await profile(c.access_token).expect(200);
    await refresh(c.refresh_token).expect(201);
    const again = (await login(victim.email).expect(201)).body as { access_token: string };
    await profile(again.access_token).expect(200);
  });

  it('revoking every session ends every live family of every user in one transaction', async () => {
    const one = await createUser(app, shop, Role.MANAGER, PASSWORD);
    const two = await createUser(app, other, Role.MANAGER, PASSWORD);
    const s1 = (await login(one.email).expect(201)).body as { access_token: string; refresh_token: string };
    const s2 = (await login(two.email).expect(201)).body as { access_token: string; refresh_token: string };
    const liveBefore = await prisma.refreshToken.count({ where: { isRevoked: false } });
    expect(liveBefore).toBeGreaterThanOrEqual(2);
    const versionsBefore = await prisma.user.findMany({ where: { id: { in: [one.id, two.id] } }, select: { id: true, tokenVersion: true } });

    const result = await revokeAllSessions(prisma);
    expect(result.refreshTokensRevoked).toBe(liveBefore);
    expect(result.usersBumped).toBeGreaterThanOrEqual(2);
    expect(await prisma.refreshToken.count({ where: { isRevoked: false } })).toBe(0);
    const versionsAfter = await prisma.user.findMany({ where: { id: { in: [one.id, two.id] } }, select: { id: true, tokenVersion: true } });
    for (const after of versionsAfter) {
      const before = versionsBefore.find((v) => v.id === after.id)!;
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    }

    await profile(s1.access_token).expect(401);
    await profile(s2.access_token).expect(401);
    await refresh(s1.refresh_token).expect(401);
    await refresh(s2.refresh_token).expect(401);
    const back = (await login(one.email).expect(201)).body as { access_token: string };
    await profile(back.access_token).expect(200);
  });
});

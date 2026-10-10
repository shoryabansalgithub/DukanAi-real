/**
 * Authentication hardening and resource limits (audit P1-4, P1-5, P1-6,
 * P2-10, P1-9; all fixed). Findings that are still open use `it.failing`; see README.md.
 * P1-4, P1-5, P1-6, P1-7 and P2-10 were fixed in roadmap phase 2 and run as
 * plain `it`.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { validateSync } from 'class-validator';
import { parse } from 'dotenv';
import { readFileSync } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { AuthBypassService } from '../../src/auth/auth-bypass.service';
import { AuthConfig } from '../../src/config/domains/auth.config';
import { JwtConfig } from '../../src/config/domains/jwt.config';
import { hydrateFromEnv } from '../../src/config/hydrate-from-env';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bootApp, createShop, httpTarget, TestShop } from '../integration/pos-fixtures';
import { createUser, httpAs, ownerOf } from './security-fixtures';

const API_ROOT = path.resolve(__dirname, '..', '..');
const PASSWORD = 'Correct-Horse-9';

describe('security: authentication and limits', () => {
  let app: INestApplication;
  let shop: TestShop;

  beforeAll(async () => {
    app = await bootApp();
    shop = await createShop(app, 'auth');
  });

  afterAll(async () => {
    await app?.close();
  });

  const login = (email: string, password: string, userAgent = 'jest') =>
    request(httpTarget(app)).post('/api/auth/login').set('User-Agent', userAgent).send({ email, password });

  it('control: the login route issues a token for the right password and refuses a wrong one', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const ok = await login(user.email, PASSWORD);
    expect(ok.status).toBe(201);
    expect(typeof ok.body.access_token).toBe('string');
    expect((await login(user.email, 'wrong')).status).toBe(401);
  });

  it('P1-4: five wrong passwords do not revoke a session that was already open', async () => {
    const user = await createUser(app, shop, Role.MANAGER, PASSWORD);
    const session = await login(user.email, PASSWORD);
    expect(session.status).toBe(201);
    for (let i = 0; i < 5; i++) {
      expect((await login(user.email, `wrong-${i}`)).status).toBe(401);
    }

    const profile = await request(httpTarget(app)).get('/api/auth/profile').set('Authorization', `Bearer ${session.body.access_token}`);
    expect(profile.status).toBe(200);
  });

  it('P2-10: a login from a browser with a 300-character User-Agent succeeds', async () => {
    const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const res = await login(user.email, PASSWORD, `Mozilla/5.0 ${'FBAN/FBIOS;'.repeat(30)}`);
    expect(res.status).toBe(201);
  });

  it('P1-5: the committed placeholder JWT secret fails configuration validation in production', () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const placeholder = hydrateFromEnv(JwtConfig, { JWT_SECRET: '___REPLACE_ME_IN_PRODUCTION___', JWT_EXPIRES_IN: '1d', JWT_REFRESH_EXPIRES_IN: '7d' });
      expect(validateSync(placeholder).map((e) => e.property)).toEqual(['jwtSecret']);
      const short = hydrateFromEnv(JwtConfig, { JWT_SECRET: 'tooshort', JWT_EXPIRES_IN: '1d', JWT_REFRESH_EXPIRES_IN: '7d' });
      expect(validateSync(short).map((e) => e.property)).toEqual(['jwtSecret']);
      const real = hydrateFromEnv(JwtConfig, { JWT_SECRET: 'k9vP2xR7mQ4tW8zB1nL6cH3jF5dS0aY2eU4iO7pA9sD1fG3h', JWT_EXPIRES_IN: '1d', JWT_REFRESH_EXPIRES_IN: '7d' });
      expect(validateSync(real)).toEqual([]);
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  describe('P1-6: the auth bypass cannot be reached by starting without NODE_ENV', () => {
    it('AUTH_DISABLED is ignored when NODE_ENV is production', () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const config = Object.assign(new AuthConfig(), { authDisabled: true });
        const bypass = new AuthBypassService(config, app.get(PrismaService));
        expect(bypass.isEnabled).toBe(false);
      } finally {
        process.env.NODE_ENV = nodeEnv;
      }
    });

    it('the committed development template does not switch authentication off', () => {
      const template = parse(readFileSync(path.join(API_ROOT, '.env.development')));
      expect(template.AUTH_DISABLED ?? 'false').not.toBe('true');
    });

    it('start:prod pins NODE_ENV=production so the development template is never loaded', () => {
      const pkg = JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      expect(pkg.scripts['start:prod']).toMatch(/NODE_ENV=production/);
    });
  });

  it('P1-7: suspending or deleting a user never returns the password hash', async () => {
    const owner = ownerOf(shop);
    const victim = await createUser(app, shop, Role.CASHIER, PASSWORD);
    const suspended = await (await httpAs(app, shop, owner)).patch(`/api/users/${victim.id}/suspend`).send({ isActive: false });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ id: victim.id, isActive: false });
    expect(suspended.body.password).toBeUndefined();

    const deleted = await (await httpAs(app, shop, owner)).delete(`/api/users/${victim.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.password).toBeUndefined();
    expect(Object.keys(deleted.body)).not.toEqual(expect.arrayContaining(['password', 'failedAttempts', 'lockedUntil']));
  });

  it('P1-9: a 30 MB upload is refused with 413 instead of being buffered', async () => {
    const res = await (await httpAs(app, shop, ownerOf(shop)))
      .post('/api/imports/products/upload')
      .attach('file', Buffer.alloc(30 * 1024 * 1024, 0x41), 'big.csv');
    expect(res.status).toBe(413);
  });
});

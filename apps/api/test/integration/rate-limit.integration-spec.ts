/**
 * Roadmap 2.1 (audit P1-3, P2-16): per-IP rate limiting on the credential
 * routes, counted in Redis so every API instance shares the buckets, with the
 * client address taken from X-Forwarded-For only where TRUST_PROXY says so.
 *
 * `.env.test` leaves every window wide open (the other suites hammer the API
 * from one address), so this suite boots its own apps with tight limits.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import type Redis from 'ioredis';
import request from 'supertest';
import { applyTrustProxy } from '../../src/common/http/trust-proxy';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { THROTTLE_KEY_PREFIX } from '../../src/common/throttling/redis-throttler.storage';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, TestShop } from './pos-fixtures';

const AUTH_SHORT_LIMIT = 3;
const GENERAL_SHORT_LIMIT = 6;
const ACCOUNT_LIMIT = 8;
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_MS = 2_000;
const WINDOW_MS = 60_000;
const PASSWORD = 'Correct-Horse-9';

const OVERRIDES: Record<string, string> = {
  RATE_LIMIT_SHORT_TTL_MS: String(WINDOW_MS),
  RATE_LIMIT_SHORT_LIMIT: String(GENERAL_SHORT_LIMIT),
  RATE_LIMIT_MEDIUM_LIMIT: '100000',
  RATE_LIMIT_LONG_LIMIT: '100000',
  AUTH_RATE_LIMIT_SHORT_LIMIT: String(AUTH_SHORT_LIMIT),
  AUTH_RATE_LIMIT_MEDIUM_LIMIT: '100000',
  AUTH_RATE_LIMIT_LONG_LIMIT: '100000',
  AUTH_RATE_LIMIT_ACCOUNT_LIMIT: String(ACCOUNT_LIMIT),
  SECURITY_MAX_LOGIN_ATTEMPTS: String(MAX_LOGIN_ATTEMPTS),
  SECURITY_LOCKOUT_DURATION_MS: String(LOCKOUT_MS),
};

/** A distinct forwarded client per call, so per-IP buckets stay out of the way while a proxy is trusted. */
let nextClient = 1;
const freshClient = () => ({ 'X-Forwarded-For': `198.51.100.${(nextClient++ % 250) + 1}` });

async function deleteThrottleKeys(redis: Redis): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${THROTTLE_KEY_PREFIX}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

describe('rate limiting on credential routes (roadmap 2.1)', () => {
  let app: INestApplication;
  let redis: Redis;
  let shop: TestShop;
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(OVERRIDES)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
    app = await bootApp();
    // supertest opens an ephemeral listener per request on a server that is not
    // listening; 300 parallel logins need one listening socket instead.
    await app.listen(0);
    redis = app.get<Redis>(REDIS_CLIENT);
    await deleteThrottleKeys(redis); // buckets from earlier suites (same route, same address)
    shop = await createShop(app, 'ratelimit');
  });

  afterAll(async () => {
    if (redis) await deleteThrottleKeys(redis);
    await app?.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const login = (target: INestApplication, email: string, password = 'wrong-password', headers: Record<string, string> = {}) =>
    request(target.getHttpServer()).post('/api/auth/login').set(headers).send({ email, password });

  it('every credential route carries the auth limits, no other route does', async () => {
    const owner = ownerOf(shop);
    const server = app.getHttpServer();
    const credentialRoutes = [
      request(server).post('/api/auth/login').send({}),
      request(server).post('/api/auth/register').send({}),
      request(server).post('/api/auth/refresh').send({ refresh_token: 'not-a-token' }),
      request(server).post('/api/auth/google').send({}),
      request(server).post('/api/invitations/accept').send({}),
    ];
    for (const res of await Promise.all(credentialRoutes)) {
      expect(res.headers['x-ratelimit-limit-auth-short']).toBe(String(AUTH_SHORT_LIMIT));
      expect(res.headers['x-ratelimit-limit-short']).toBeUndefined();
    }

    const general = await (await httpAs(app, shop, owner)).get('/api/products');
    expect(general.status).toBe(200);
    expect(general.headers['x-ratelimit-limit-short']).toBe(String(GENERAL_SHORT_LIMIT));
    expect(general.headers['x-ratelimit-limit-auth-short']).toBeUndefined();

    await deleteThrottleKeys(redis);
  });

  it('answers 429 with Retry-After once the login limit is exceeded, and counts in Redis', async () => {
    const user = await createUser(app, shop, Role.CASHIER, 'Correct-Horse-9');
    for (let i = 0; i < AUTH_SHORT_LIMIT; i++) {
      const res = await login(app, user.email);
      expect(res.status).toBe(401);
      expect(res.headers['x-ratelimit-remaining-auth-short']).toBe(String(AUTH_SHORT_LIMIT - i - 1));
    }

    const blocked = await login(app, user.email, 'Correct-Horse-9');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after-auth-short'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after-auth-short'])).toBeLessThanOrEqual(WINDOW_MS / 1000);

    const keys = await redis.keys(`${THROTTLE_KEY_PREFIX}*`);
    expect(keys.some((k) => k.endsWith(':hits'))).toBe(true);
    expect(keys.some((k) => k.endsWith(':block'))).toBe(true);
  });

  it('a spoofed X-Forwarded-For does not escape the block while no proxy is trusted', async () => {
    const res = await login(app, 'anyone@test.local', 'x', { 'X-Forwarded-For': '203.0.113.9' });
    expect(res.status).toBe(429);
  });

  it('a second API instance sees the same Redis bucket, and honours X-Forwarded-For only once a proxy is trusted', async () => {
    const other = await bootApp();
    await other.listen(0);
    try {
      expect((await login(other, 'anyone@test.local')).status).toBe(429);
      expect((await login(other, 'anyone@test.local', 'x', { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(429);

      applyTrustProxy(other, '1');
      const viaProxy = await login(other, 'anyone@test.local', 'x', { 'X-Forwarded-For': '203.0.113.9' });
      expect(viaProxy.status).toBe(401); // a different client, its own bucket
      expect(viaProxy.headers['x-ratelimit-remaining-auth-short']).toBe(String(AUTH_SHORT_LIMIT - 1));

      applyTrustProxy(other, 'false');
      expect((await login(other, 'anyone@test.local', 'x', { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(429);
    } finally {
      await other.close();
    }
  });

  it('general routes are limited by the general windows', async () => {
    await deleteThrottleKeys(redis);
    const owner = ownerOf(shop);
    for (let i = 0; i < GENERAL_SHORT_LIMIT; i++) {
      expect((await (await httpAs(app, shop, owner)).get('/api/products')).status).toBe(200);
    }
    const blocked = await (await httpAs(app, shop, owner)).get('/api/products');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after-short']).toBeDefined();
    // The block is per address, not per user: another user of the same shop is blocked too.
    const cashier = await createUser(app, shop, Role.CASHIER);
    expect((await (await httpAs(app, shop, cashier)).get('/api/products')).status).toBe(429);
    await deleteThrottleKeys(redis);
  });

  it('300 concurrent bad logins yield only 401s up to the limit and 429s beyond it, never a 5xx, and do not revoke an open session', async () => {
    await deleteThrottleKeys(redis);
    const user = await createUser(app, shop, Role.MANAGER, PASSWORD);
    const session = await login(app, user.email, PASSWORD);
    expect(session.status).toBe(201);
    await deleteThrottleKeys(redis);

    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => login(app, user.email, `wrong-${i}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(AUTH_SHORT_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(300 - AUTH_SHORT_LIMIT);
    expect(statuses.some((s) => s >= 500)).toBe(false);

    // The failures that got through reached the lock threshold; the session issued before stays valid (P1-4).
    const locked = await app.get(PrismaService).user.findUniqueOrThrow({ where: { id: user.id }, select: { isLocked: true, failedAttempts: true } });
    expect(locked).toEqual({ isLocked: true, failedAttempts: MAX_LOGIN_ATTEMPTS });
    const profile = await request(app.getHttpServer()).get('/api/auth/profile').set('Authorization', `Bearer ${session.body.access_token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.email).toBe(user.email);
  });

  describe('lockout (roadmap 2.2)', () => {
    beforeAll(() => applyTrustProxy(app, '1'));
    afterAll(() => applyTrustProxy(app, 'false'));
    beforeEach(() => deleteThrottleKeys(redis));

    it('locks new logins after the configured failures, keeps the open session, and clears the lock when it expires', async () => {
      const prisma = app.get(PrismaService);
      const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
      const session = await login(app, user.email, PASSWORD, freshClient());
      expect(session.status).toBe(201);

      for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
        expect((await login(app, user.email, `wrong-${i}`, freshClient())).status).toBe(401);
      }
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { isLocked: true, lockedUntil: true, failedAttempts: true } });
      expect(row.isLocked).toBe(true);
      expect(row.failedAttempts).toBe(MAX_LOGIN_ATTEMPTS);
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Locked: the right password is refused for a new login ...
      expect((await login(app, user.email, PASSWORD, freshClient())).status).toBe(401);
      // ... while the session opened before the lock keeps working.
      const profile = await request(app.getHttpServer()).get('/api/auth/profile').set('Authorization', `Bearer ${session.body.access_token}`);
      expect(profile.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, LOCKOUT_MS + 300));
      const again = await login(app, user.email, PASSWORD, freshClient());
      expect(again.status).toBe(201);
      const cleared = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { isLocked: true, lockedUntil: true, failedAttempts: true } });
      expect(cleared).toEqual({ isLocked: false, lockedUntil: null, failedAttempts: 0 });
    });

    it('a wrong password after an expired lock starts a fresh count instead of re-locking at once', async () => {
      const prisma = app.get(PrismaService);
      const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
      await prisma.user.update({ where: { id: user.id }, data: { isLocked: true, failedAttempts: MAX_LOGIN_ATTEMPTS, lockedUntil: new Date(Date.now() - 1000) } });

      expect((await login(app, user.email, 'wrong', freshClient())).status).toBe(401);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { isLocked: true, failedAttempts: true } });
      expect(row).toEqual({ isLocked: false, failedAttempts: 1 });
    });

    it('attempts on one account from many addresses are capped per account', async () => {
      const user = await createUser(app, shop, Role.CASHIER, PASSWORD);
      const statuses: number[] = [];
      for (let i = 0; i <= ACCOUNT_LIMIT; i++) {
        const res = await login(app, user.email.toUpperCase(), `wrong-${i}`, freshClient());
        statuses.push(res.status);
        if (res.status !== 429) expect(res.headers['x-ratelimit-limit-auth-account']).toBe(String(ACCOUNT_LIMIT));
        else expect(Number(res.headers['retry-after-auth-account'])).toBeGreaterThan(0);
      }
      expect(statuses.slice(0, ACCOUNT_LIMIT).every((s) => s === 401)).toBe(true);
      expect(statuses[ACCOUNT_LIMIT]).toBe(429);
      // Another account from the same fresh address is not affected.
      const other = await createUser(app, shop, Role.CASHIER, PASSWORD);
      expect((await login(app, other.email, 'wrong', freshClient())).status).toBe(401);
    });
  });
});

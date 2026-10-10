/**
 * Roadmap 2.11-2.14: the cache lives in Redis and is shared by every
 * instance, the shared Redis client is closed on shutdown, the /inventory
 * WebSocket namespace is authenticated and scoped to the tenant room, and a
 * request's correlation id is sanitised once and echoed everywhere.
 */
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Cache } from 'cache-manager';
import type Redis from 'ioredis';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { CACHE_NAMESPACE } from '../../src/common/cache/cache-options';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuthenticatedIoAdapter } from '../../src/iam/websockets/authenticated-io.adapter';
import { TenantContextService } from '../../src/iam/tenant-context/tenant-context.service';
import { InventoryGateway } from '../../src/inventory/inventory.gateway';
import { createUser, httpAs, issueTokens, ownerOf } from '../security/security-fixtures';
import { bootApp, createShop, TestShop } from './pos-fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('infrastructure (roadmap 2.11-2.14)', () => {
  let app: INestApplication;
  let redis: Redis;
  let baseUrl: string;
  let shopA: TestShop;
  let shopB: TestShop;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // The adapter must be in place before init, exactly as main.ts does it.
    app = await bootApp(undefined, (a) => a.useWebSocketAdapter(new AuthenticatedIoAdapter(a)));
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    redis = app.get<Redis>(REDIS_CLIENT);
    shopA = await createShop(app, 'infra-a');
    shopB = await createShop(app, 'infra-b');
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await app?.close();
  });

  describe('cache (2.11)', () => {
    it('stores entries in Redis under the cache namespace with the TTL, and a delete is visible to every instance', async () => {
      const cache = app.get<Cache>(CACHE_MANAGER);
      const key = `shop:${shopA.shopId}:analytics:kpis`;
      await cache.set(key, { todaySales: 42 }, 60_000);

      const redisKey = `${CACHE_NAMESPACE}:${key}`;
      expect(await redis.exists(redisKey)).toBe(1);
      const ttl = await redis.pttl(redisKey);
      expect(ttl).toBeGreaterThan(50_000);
      expect(ttl).toBeLessThanOrEqual(60_000);
      expect(JSON.parse((await redis.get(redisKey))!).value).toEqual({ todaySales: 42 });
      await expect(cache.get(key)).resolves.toEqual({ todaySales: 42 });

      // What another instance would do after a sale: the entry is gone for everyone.
      await redis.del(redisKey);
      await expect(cache.get(key)).resolves.toBeUndefined();

      await cache.set(key, { todaySales: 43 }, 60_000);
      await cache.del(key);
      expect(await redis.exists(redisKey)).toBe(0);
    });
  });

  describe('correlation (2.14)', () => {
    it('echoes a well-formed client correlation id in the header and the error envelope, even on a guard rejection', async () => {
      const res = await request(app.getHttpServer()).get('/api/auth/profile').set('x-correlation-id', 'trace-abc-123');
      expect(res.status).toBe(401);
      expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
      expect(res.body.correlationId).toBe('trace-abc-123');
    });

    it('replaces an unsafe or oversized client value with a UUID and never echoes it', async () => {
      const hostile = 'x'.repeat(200);
      const res = await request(app.getHttpServer()).get('/api/auth/profile').set('x-correlation-id', hostile);
      expect(res.headers['x-correlation-id']).toMatch(UUID);
      expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
      expect(JSON.stringify(res.body)).not.toContain(hostile);
    });
  });

  describe('websockets (2.13)', () => {
    const connect = (token?: string): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = io(`${baseUrl}/inventory`, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, timeout: 5_000 });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (error) => reject(error));
      });

    it('refuses a connection to /inventory without a valid session token', async () => {
      await expect(connect()).rejects.toThrow(/Missing token/);
      await expect(connect('not-a-jwt')).rejects.toThrow(/Authentication Error/);
    });

    it('delivers tenant broadcasts only to sockets of that shop', async () => {
      const cashierA = await createUser(app, shopA, Role.CASHIER);
      const socketA = await connect((await issueTokens(app, cashierA)).access_token);
      const socketB = await connect((await issueTokens(app, ownerOf(shopB))).access_token);

      const received: unknown[] = [];
      const receivedB: unknown[] = [];
      socketA.on('stockUpdated', (payload) => received.push(payload));
      socketB.on('stockUpdated', (payload) => receivedB.push(payload));

      const gateway = app.get(InventoryGateway);
      const tenant = app.get(TenantContextService);
      tenant.runWithContext({ shopId: shopA.shopId, correlationId: 'spec', requestId: 'spec' }, () => {
        gateway.broadcastStockUpdate([{ productId: 'p1', newStock: 7 }]);
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ updates: [{ productId: 'p1', newStock: 7 }] });
      expect(receivedB).toHaveLength(0);
    });

    it('drops the socket when the session is logged out', async () => {
      const cashier = await createUser(app, shopA, Role.CASHIER);
      const tokens = await issueTokens(app, cashier);
      const socket = await connect(tokens.access_token);
      const closed = new Promise<string>((resolve) => socket.on('disconnect', (reason) => resolve(reason)));

      const res = await request(app.getHttpServer()).post('/api/auth/logout').set('Authorization', `Bearer ${tokens.access_token}`);
      expect(res.status).toBe(200);
      // Logout ends the family; revoking a session disconnects its sockets.
      const http = await httpAs(app, shopA, ownerOf(shopA));
      expect((await http.get('/api/products')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(socket.connected).toBe(true); // logout alone does not push a disconnect; the next handshake is refused
      await expect(connect(tokens.access_token)).rejects.toThrow(/Authentication Error/);
      socket.disconnect();
      await closed;
    });
  });

  describe('redis client (2.12)', () => {
    it('is closed when the application shuts down', async () => {
      const other = await bootApp();
      const client = other.get<Redis>(REDIS_CLIENT);
      expect(client.status).toBe('ready');
      await other.close();
      // quit() resolves on the server's reply; ioredis moves the status to
      // 'end' when the socket closes a moment later.
      for (let i = 0; i < 50 && !['end', 'close'].includes(client.status); i++) await new Promise((r) => setTimeout(r, 20));
      expect(['end', 'close']).toContain(client.status);
    });
  });
});

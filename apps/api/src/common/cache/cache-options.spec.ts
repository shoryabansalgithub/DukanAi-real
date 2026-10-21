import { Logger } from '@nestjs/common';
import * as net from 'net';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { CacheConfig } from '../../config/domains/cache.config';
import { RedisConfig } from '../../config/domains/redis.config';
import { buildCacheOptions, CACHE_NAMESPACE } from './cache-options';

describe('buildCacheOptions', () => {
  const cacheConfig = Object.assign(new CacheConfig(), { ttl: 1234 });
  const logger = { warn: jest.fn() } as unknown as Logger;

  it('backs the cache with a Keyv Redis store under the cache namespace when REDIS_URL is set', () => {
    const options = buildCacheOptions(Object.assign(new RedisConfig(), { redisUrl: 'redis://127.0.0.1:6379/3' }), cacheConfig, logger, { eagerConnect: false }) as {
      stores: Keyv[];
      ttl: number;
    };
    expect(options.ttl).toBe(1234);
    expect(options.stores).toHaveLength(1);
    const keyv = options.stores[0];
    expect(keyv).toBeInstanceOf(Keyv);
    expect(keyv.opts.store).toBeInstanceOf(KeyvRedis);
    expect(keyv.opts.namespace).toBe(CACHE_NAMESPACE);
    expect((keyv.opts.store as KeyvRedis<unknown>).namespace).toBe(CACHE_NAMESPACE); // handed down to the adapter
    expect(keyv.opts.useKeyPrefix).toBe(false); // the adapter prefixes `cache:` once
    expect(keyv.opts.ttl).toBe(1234);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to an in-process cache without REDIS_URL and says so', () => {
    const options = buildCacheOptions(new RedisConfig(), cacheConfig, logger);
    expect(options).toEqual({ ttl: 1234 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not shared'));
  });
});

/**
 * Roadmap 9.18 (Redis stopped for 5 minutes): the cache must answer at once
 * while Redis is away, not queue the command until it returns. A minimal
 * in-process server speaks enough of the Redis protocol for the client to
 * connect and read; then it disappears.
 */
describe('buildCacheOptions while Redis is away', () => {
  // A destroyed client may still be in its reconnect back-off sleep (at most 2 s): let it end.
  afterAll(() => new Promise((r) => setTimeout(r, 2_100)));

  function fakeRedis(): Promise<{ port: number; kill(): Promise<void>; mute(): void }> {
    const sockets = new Set<net.Socket>();
    let muted = false;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        // Muted: the connection stays open and every command is swallowed (a blackholed Redis).
        if (muted) return;
        buffer += chunk.toString('latin1');
        // Answer every complete RESP array: GET is a miss, everything else OK.
        for (;;) {
          const m = /^\*(\d+)\r\n/.exec(buffer);
          if (!m) return;
          let rest = buffer.slice(m[0].length);
          const parts: string[] = [];
          for (let i = 0; i < Number(m[1]); i++) {
            const b = /^\$(\d+)\r\n/.exec(rest);
            if (!b || rest.length < b[0].length + Number(b[1]) + 2) return;
            parts.push(rest.slice(b[0].length, b[0].length + Number(b[1])));
            rest = rest.slice(b[0].length + Number(b[1]) + 2);
          }
          buffer = rest;
          const command = (parts[0] ?? '').toUpperCase();
          socket.write(command === 'GET' ? '$-1\r\n' : command === 'UNLINK' || command === 'DEL' ? ':1\r\n' : '+OK\r\n');
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        resolve({
          port,
          kill: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
          mute: () => {
            muted = true;
          },
        });
      });
    });
  }

  it('answers a miss at once, for reads and deletes, once Redis has gone away', async () => {
    const redis = await fakeRedis();
    const logger = { warn: jest.fn() } as unknown as Logger;
    const options = buildCacheOptions(Object.assign(new RedisConfig(), { redisUrl: `redis://127.0.0.1:${redis.port}/0`, connectTimeoutMs: 500 }), new CacheConfig(), logger, { eagerConnect: false }) as { stores: Keyv[] };
    const keyv = options.stores[0];
    expect(await keyv.get('k')).toBeUndefined(); // connected, a real miss
    await redis.kill();
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const outcome = await Promise.race([
      Promise.all([keyv.get('k'), keyv.delete('k')]).then(() => 'answered'),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    expect(outcome).toBe('answered');
    expect(Date.now() - started).toBeLessThan(1000);
    // Stop the client's background reconnects so the test leaves nothing running.
    await (keyv.opts.store as KeyvRedis<unknown>).client.destroy();
  });

  it('bounds every command when Redis accepts it and never replies (audit R3)', async () => {
    const redis = await fakeRedis();
    const logger = { warn: jest.fn() } as unknown as Logger;
    const options = buildCacheOptions(
      Object.assign(new RedisConfig(), { redisUrl: `redis://127.0.0.1:${redis.port}/0`, connectTimeoutMs: 500, commandTimeoutMs: 300 }),
      new CacheConfig(),
      logger,
    ) as { stores: Keyv[] };
    const keyv = options.stores[0];
    expect(await keyv.get('k')).toBeUndefined();
    redis.mute();
    const started = Date.now();
    const outcome = await Promise.race([
      Promise.all([keyv.get('k'), keyv.delete('k'), keyv.set('k', 1)]).then(() => 'answered'),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    expect(outcome).toBe('answered');
    expect(Date.now() - started).toBeLessThan(1500);
    await (keyv.opts.store as KeyvRedis<unknown>).client.destroy();
    await redis.kill();
  });

  it('a client that never connected answers at once, not after the connect timeout on every call (audit R4)', async () => {
    // A port nothing listens on.
    const closed = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    const logger = { warn: jest.fn() } as unknown as Logger;
    const options = buildCacheOptions(Object.assign(new RedisConfig(), { redisUrl: `redis://127.0.0.1:${closed}/0`, connectTimeoutMs: 3000 }), new CacheConfig(), logger) as {
      stores: Keyv[];
    };
    const keyv = options.stores[0];
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      await Promise.all([keyv.get('k'), keyv.delete('k')]);
      expect(Date.now() - started).toBeLessThan(500);
    }
    await (keyv.opts.store as KeyvRedis<unknown>).client.destroy();
  });
});

/**
 * Deployment contract (roadmap 7.3): the probes an orchestrator wires to, and
 * a graceful shutdown of the real compiled API on SIGTERM.
 *
 * Part 1 boots AppModule in-process: liveness answers without a dependency,
 * readiness reports the database and Redis and is 503 while Redis is down or
 * the instance drains. Part 2 spawns `node dist/main` (built on demand, like
 * the boot regression) against the test database, sends SIGTERM, and proves
 * that readiness flips to 503 while the listener is still up, that the
 * process exits 0 on its own, and that it closed Prisma and Redis on the way.
 */
import { INestApplication } from '@nestjs/common';
import { ChildProcess, execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import * as path from 'path';
import Redis from 'ioredis';
import request from 'supertest';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { GracefulShutdownService } from '../../src/common/lifecycle/graceful-shutdown.service';
import { bootApp } from './pos-fixtures';

const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number, every = 50): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
};

describe('deployment: probes and graceful shutdown (roadmap 7.3)', () => {
  describe('probes (in-process)', () => {
    let app: INestApplication;
    let redis: Redis;
    const http = () => request(app.getHttpServer());

    beforeAll(async () => {
      app = await bootApp();
      redis = app.get<Redis>(REDIS_CLIENT);
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/health and /api/health/live are public liveness answers', async () => {
      for (const route of ['/api/health', '/api/health/live']) {
        const res = await http().get(route).expect(200);
        expect(res.body).toMatchObject({ status: 'ok' });
        expect(typeof res.body.uptimeSeconds).toBe('number');
        expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      }
    });

    it('GET /api/health/ready is 200 with every dependency up', async () => {
      const res = await http().get('/api/health/ready').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });

    it('readiness is 503 while Redis is down and recovers when it is back', async () => {
      redis.disconnect();
      await waitFor(() => redis.status === 'end', 5_000);
      const down = await http().get('/api/health/ready').expect(503);
      expect(down.body).toMatchObject({ status: 'unavailable', checks: { database: 'up', redis: 'down' } });

      await redis.connect();
      await waitFor(() => redis.status === 'ready', 10_000);
      await http().get('/api/health/ready').expect(200);
    });

    it('readiness is 503 "draining" once a shutdown is requested, liveness stays 200', async () => {
      await app.get(GracefulShutdownService).beforeApplicationShutdown();
      const res = await http().get('/api/health/ready').expect(503);
      expect(res.body).toMatchObject({ status: 'draining', checks: { database: 'up', redis: 'up' } });
      await http().get('/api/health/live').expect(200);
    });
  });

  describe('SIGTERM on the compiled API', () => {
    const apiRoot = path.resolve(__dirname, '../..');
    const entrypoint = path.join(apiRoot, 'dist/main.js');
    const drainDelayMs = 1_500;
    let child: ChildProcess;
    let port: number;
    let output = '';

    const freePort = () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
        });
      });

    const ready = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
        return { status: res.status, body: (await res.json()) as { status: string } };
      } catch {
        return null;
      }
    };

    beforeAll(async () => {
      if (!existsSync(entrypoint)) execSync('npm run build', { cwd: apiRoot, stdio: 'inherit' });
      port = await freePort();
      child = spawn(process.execPath, [entrypoint], {
        cwd: apiRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          FRONTEND_URL: 'http://localhost:3000',
          CRON_ENABLED: 'false',
          PRISMA_LOG_QUERIES: 'false',
          SHUTDOWN_DRAIN_DELAY_MS: String(drainDelayMs),
          SHUTDOWN_TIMEOUT_MS: '20000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      await waitFor(async () => (await ready())?.status === 200, 120_000, 250);
    }, 300_000);

    afterAll(() => {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    });

    it('flips readiness to 503 while still listening, then exits 0 with Prisma and Redis closed', async () => {
      expect((await ready())?.body.status).toBe('ok');

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      const sentAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);

      // The drain window: the listener is still up and readiness says so.
      const seen = new Set<string>();
      await waitFor(async () => {
        const res = await ready();
        if (res) seen.add(`${res.status}:${res.body.status}`);
        return seen.has('503:draining');
      }, drainDelayMs + 5_000);
      expect(seen.has('503:draining')).toBe(true);

      const { code, signal } = await exited;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(Date.now() - sentAt).toBeLessThan(20_000);
      expect(output).toContain('Shutdown requested by SIGTERM');
      expect(output).toContain('Database connection closed');
      expect(output).not.toContain('still draining after');
      expect(await ready()).toBeNull();
    }, 60_000);
  });
});

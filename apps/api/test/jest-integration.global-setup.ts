import { readFileSync } from 'fs';
import * as path from 'path';
import { parse } from 'dotenv';
import Redis from 'ioredis';

/**
 * Integration suites share one Redis database (`.env.test` REDIS_URL, db 1).
 * Jobs left behind by an interrupted run, or by a suite that was force-exited
 * while a worker was mid-job, are picked up by the next app to boot, whose
 * processor then writes audit rows in the middle of another test's
 * before/after snapshot. Every run therefore starts from an empty test
 * database. Only a dedicated database (index >= 1) is ever flushed.
 *
 * Precedence mirrors the app's: TEST_REDIS_URL, then the real environment,
 * then apps/api/.env.test.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? envFileValue('REDIS_URL') ?? 'redis://localhost:6379/1';
  const parsed = new URL(url);
  const db = Number(parsed.pathname.replace(/^\//, ''));
  const target = `${parsed.hostname}:${parsed.port || 6379}/${parsed.pathname.replace(/^\//, '') || '0'}`;
  if (!Number.isInteger(db) || db < 1) {
    console.warn(`[integration] Redis ${target} is not a dedicated test database (index >= 1); leaving it untouched.`);
    return;
  }
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  try {
    await redis.connect();
    await redis.flushdb();
    console.log(`[integration] flushed Redis test database ${target}`);
  } finally {
    redis.disconnect();
  }
}

function envFileValue(key: string): string | undefined {
  try {
    return parse(readFileSync(path.resolve(__dirname, '..', '.env.test')))[key];
  } catch {
    return undefined;
  }
}

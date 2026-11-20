import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.module';
import Redis from 'ioredis';

/** One held lock: extend it (a lost lock rejects) or release it (only while still ours). */
export interface HeldLock {
  extend(ttlMs: number): Promise<HeldLock>;
  release(): Promise<void>;
}

/** Acquires `resource` for `ttlMs`; null when another holder has it. Rejects when Redis does not answer. */
export interface LockClient {
  acquire(resource: string, ttlMs: number): Promise<HeldLock | null>;
}

/** Sets the TTL again only while the key still holds this holder's token. */
const EXTEND_IF_OURS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Deletes the key only while it still holds this holder's token. */
const RELEASE_IF_OURS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * The lock on the one shared Redis (release audit, dependencies): `SET key
 * <random token> PX ttl NX` takes it, and the token-checked scripts above
 * extend and release it, so a holder never touches a lock that expired and
 * was taken by another instance. It replaces redlock 5, whose only release is
 * a beta that has not moved since 2022; with a single Redis node the Redlock
 * quorum added nothing. The key is the resource name itself, as redlock used,
 * so old and new instances exclude each other during a rolling deploy.
 */
export function redisLockClient(redis: Redis): LockClient {
  const held = (resource: string, token: string): HeldLock => ({
    async extend(ttlMs: number): Promise<HeldLock> {
      const extended = await redis.eval(EXTEND_IF_OURS, 1, resource, token, String(ttlMs));
      if (Number(extended) !== 1) throw new Error(`lock ${resource} is no longer held by this instance`);
      return held(resource, token);
    },
    async release(): Promise<void> {
      await redis.eval(RELEASE_IF_OURS, 1, resource, token);
    },
  });
  return {
    async acquire(resource: string, ttlMs: number): Promise<HeldLock | null> {
      const token = randomBytes(16).toString('hex');
      const taken = await redis.set(resource, token, 'PX', ttlMs, 'NX');
      return taken === 'OK' ? held(resource, token) : null;
    },
  };
}

export const CRON_LOCK_ALLOW_UNLOCKED_ENV = 'CRON_LOCK_ALLOW_UNLOCKED';

/** How often a held lock is extended, as a fraction of its TTL (and never more often than once a second). */
export function extensionIntervalMs(ttlMs: number): number {
  return Math.max(1_000, Math.floor(ttlMs / 3));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class CronLockService implements OnModuleInit {
  private readonly logger = new Logger(CronLockService.name);
  private locker: LockClient | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis) {}

  onModuleInit() {
    if (!this.redisClient || this.redisClient.status === 'end') {
      this.logger.warn('REDIS_URL not configured. Cron locks will fallback to local execution only.');
      return;
    }
    this.locker = redisLockClient(this.redisClient);
  }

  /**
   * Attempts to acquire a distributed lock. If successful, executes the callback.
   * If the lock is already held by another pod, returns null and does not execute the callback.
   *
   * With the fail-fast Redis client, `acquire` rejects when Redis is unreachable.
   * That is NOT treated as "another pod has it": the callback is skipped with a
   * warning unless CRON_LOCK_ALLOW_UNLOCKED=true, because running crons unlocked
   * on every pod is exactly what the lock exists to prevent.
   *
   * The lock is held for the whole run (audit R9): while the callback runs
   * it is extended by another `ttlMs` every third of the TTL, so a run that
   * takes longer than its TTL (a night's analytics over many shops, a slow
   * reconciliation) is never joined by a second instance that found the lock
   * expired. `ttlMs` is therefore only how long a crashed holder keeps the
   * others waiting. An extension that fails (Redis gone) is logged; the run
   * carries on, as it would have without a lock.
   *
   * @param resource The string identifier for the lock (e.g., 'cron:purge-outbox')
   * @param ttlMs Time-to-live for the lock in milliseconds, renewed while the callback runs
   * @param callback Function to execute if lock is acquired
   */
  async withLock<T>(resource: string, ttlMs: number, callback: () => Promise<T>): Promise<T | null> {
    if (!this.locker) {
      // Fallback for dev environments without Redis
      this.logger.warn(`Bypassing distributed lock for ${resource} (Redis not configured)`);
      return await callback();
    }

    if (this.redisClient.status !== 'ready') {
      return this.handleRedisUnavailable(resource, `Redis client status is '${this.redisClient.status}'`, callback);
    }

    let lock: HeldLock | null;
    try {
      lock = await this.locker.acquire(resource, ttlMs);
    } catch (error) {
      return this.handleRedisUnavailable(resource, errorMessage(error), callback);
    }
    if (!lock) {
      this.logger.debug(`Lock ${resource} is held by another pod. Skipping execution.`);
      return null;
    }

    this.logger.debug(`Lock acquired: ${resource}`);
    let current = lock;
    let extending: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (extending) return;
      extending = current
        .extend(ttlMs)
        .then((next) => {
          current = next;
        })
        .catch((e: unknown) => {
          this.logger.error(`Lock ${resource} could not be extended (${errorMessage(e)}); another instance may start the same job before this run ends`);
        })
        .finally(() => {
          extending = null;
        });
    }, extensionIntervalMs(ttlMs));
    timer.unref?.();
    try {
      return await callback();
    } finally {
      clearInterval(timer);
      await extending;
      await current.release().catch((e: unknown) => {
        this.logger.error(`Failed to release lock ${resource}: ${errorMessage(e)}`);
      });
    }
  }

  private async handleRedisUnavailable<T>(resource: string, reason: string, callback: () => Promise<T>): Promise<T | null> {
    if (process.env[CRON_LOCK_ALLOW_UNLOCKED_ENV] === 'true') {
      this.logger.warn(`Could not acquire lock ${resource} (${reason}); ${CRON_LOCK_ALLOW_UNLOCKED_ENV}=true, running UNLOCKED.`);
      return await callback();
    }
    this.logger.warn(
      `Could not acquire lock ${resource} (${reason}); skipping this run. Set ${CRON_LOCK_ALLOW_UNLOCKED_ENV}=true to run unlocked.`,
    );
    return null;
  }
}

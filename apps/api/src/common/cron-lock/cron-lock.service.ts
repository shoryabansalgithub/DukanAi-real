import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.module';
import Redis from 'ioredis';
import Redlock from 'redlock';

/**
 * The runtime is redlock v5 (package "main" -> dist/cjs), but its `exports` map
 * has no `types` condition, so under nodenext TypeScript falls back to the v4
 * `@types/redlock` stubs. The v5 surface we rely on is typed structurally here.
 */
interface RedlockV5Lock {
  release(): Promise<unknown>;
}
interface RedlockExecutionStats {
  votesAgainst: Map<unknown, Error>;
}
interface RedlockExecutionError extends Error {
  attempts?: ReadonlyArray<Promise<RedlockExecutionStats>>;
}

export const CRON_LOCK_ALLOW_UNLOCKED_ENV = 'CRON_LOCK_ALLOW_UNLOCKED';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class CronLockService implements OnModuleInit {
  private readonly logger = new Logger(CronLockService.name);
  private redlock: Redlock;

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis) {}

  onModuleInit() {
    if (!this.redisClient || this.redisClient.status === 'end') {
      this.logger.warn('REDIS_URL not configured. Cron locks will fallback to local execution only.');
      return;
    }

    try {
      this.redlock = new Redlock([this.redisClient as any], {
        driftFactor: 0.01, // time in ms
        retryCount: 0, // we don't want to retry acquiring a cron lock; if we miss it, another pod got it.
        retryDelay: 200, // time in ms
        retryJitter: 200, // time in ms
      } as any);

      this.redlock.on('clientError', (error: any) => {
        // Ignore cases where a lock could not be acquired
        if (error.message && error.message.includes('attempts to lock the resource')) {
          return;
        }
        this.logger.error(`Redlock error: ${error.message}`);
      });
    } catch (err) {
      this.logger.error('Failed to initialize Redlock', err);
    }
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
   * @param resource The string identifier for the lock (e.g., 'cron:purge-outbox')
   * @param ttlMs Time-to-live for the lock in milliseconds
   * @param callback Function to execute if lock is acquired
   */
  async withLock<T>(resource: string, ttlMs: number, callback: () => Promise<T>): Promise<T | null> {
    if (!this.redlock) {
      // Fallback for dev environments without Redis
      this.logger.warn(`Bypassing distributed lock for ${resource} (Redis not configured)`);
      return await callback();
    }

    if (this.redisClient.status !== 'ready') {
      return this.handleRedisUnavailable(resource, `Redis client status is '${this.redisClient.status}'`, callback);
    }

    let lock: RedlockV5Lock;
    try {
      lock = (await this.redlock.acquire([resource], ttlMs)) as unknown as RedlockV5Lock;
    } catch (error) {
      if (await this.isHeldByAnotherPod(error)) {
        this.logger.debug(`Lock ${resource} is held by another pod. Skipping execution.`);
        return null;
      }
      return this.handleRedisUnavailable(resource, errorMessage(error), callback);
    }

    this.logger.debug(`Lock acquired: ${resource}`);
    try {
      return await callback();
    } finally {
      await lock.release().catch((e: unknown) => {
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

  /**
   * Redlock v5 rejects with an ExecutionError whether the resource is locked or
   * Redis is unreachable; the per-client votes tell them apart.
   */
  private async isHeldByAnotherPod(error: unknown): Promise<boolean> {
    if (!(error instanceof Error)) return false;
    if (error.name === 'ResourceLockedError') return true;
    if (error.name !== 'ExecutionError') return false;
    try {
      const stats = await Promise.all((error as RedlockExecutionError).attempts ?? []);
      const votes = stats.flatMap((stat) => [...stat.votesAgainst.values()]);
      return votes.length > 0 && votes.every((vote) => vote.name === 'ResourceLockedError');
    } catch {
      return false;
    }
  }
}

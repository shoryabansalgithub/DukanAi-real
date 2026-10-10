import { Prisma } from '@prisma/client';

/**
 * Prisma codes for "the database rolled this transaction back, run it again":
 *  - P2034: write conflict / deadlock detected by the query engine
 *  - P2028: the interactive transaction could not be started or was closed
 *    (pool or lock wait exhausted); nothing of it was committed
 *  - P2010: a raw query failed; retryable only for MySQL 1213 (deadlock) and
 *    1205 (lock wait timeout), which are how deadlocks on our
 *    `SELECT ... FOR UPDATE` statements surface
 */
const RETRYABLE_CODES = new Set(['P2034', 'P2028']);
const RETRYABLE_MYSQL_CODES = new Set(['1213', '1205']);

export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_CODES.has(error.code)) return true;
    if (error.code === 'P2010') {
      const dbCode = String((error.meta as { code?: unknown } | undefined)?.code ?? '');
      if (RETRYABLE_MYSQL_CODES.has(dbCode)) return true;
    }
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('deadlock found') || message.includes('lock wait timeout') || message.includes('unable to start a transaction');
}

export interface SerializationRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  randomDelayMs?: number;
}

/**
 * Runs `fn` again after a serialization failure with jittered back-off. The
 * callback must be a complete transaction (open → commit) so a retry starts
 * from a clean slate.
 */
export async function withSerializationRetry<T>(fn: (attempt: number) => Promise<T>, options: SerializationRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 50;
  const random = options.randomDelayMs ?? 100;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isSerializationFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, base + Math.random() * random));
    }
  }
}

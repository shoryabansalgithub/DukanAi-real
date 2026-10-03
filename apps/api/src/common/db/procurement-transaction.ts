import { Prisma } from '@prisma/client';
import { withSerializationRetry } from './serialization-retry';

type Db = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number; maxWait?: number }): Promise<T> };

/**
 * One business transaction of the procurement chain (roadmap 4.2): READ
 * COMMITTED, like the POS, with row locks taken explicitly where they matter
 * (`InventoryMutationEngine.lockProducts` before stock moves, the
 * NumberSequence row for numbering) and a jittered retry around the whole
 * transaction for deadlock / lock-wait rollbacks. SERIALIZABLE used to make
 * every concurrent document of a shop fail with a gap-lock deadlock instead.
 */
export function procurementTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withSerializationRetry(() => db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000, maxWait: 15_000 }), {
    attempts: 3,
    baseDelayMs: 50,
    randomDelayMs: 150,
  });
}

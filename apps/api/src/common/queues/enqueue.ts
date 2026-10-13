import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Job, JobsOptions, Queue } from 'bullmq';

export const QUEUE_UNAVAILABLE = 'QUEUE_UNAVAILABLE';

/** The answer a request gets when Redis did not take its job in time (a temporary condition: retry later). */
export class QueueUnavailableException extends ServiceUnavailableException {
  constructor(queue: string, reason: string) {
    super({
      message: 'The background job queue is unavailable at the moment; nothing was queued. Please retry in a minute.',
      code: QUEUE_UNAVAILABLE,
      details: { queue, reason },
    });
  }
}

const logger = new Logger('Enqueue');

/**
 * Adds a job on a request path within `timeoutMs` (audit R5). BullMQ's
 * Redis client queues commands while Redis is unreachable (and a queue whose
 * connection never opened waits for it), so a bare `queue.add` hung the
 * request until Redis came back. Past the budget, or on an error, this
 * throws `QueueUnavailableException` (503 QUEUE_UNAVAILABLE); the caller
 * decides what happens to the rows it wrote before (see
 * `ImportExportService.queueUpload`). The add itself cannot be withdrawn: if
 * Redis comes back it may still land later, so every worker on such a queue
 * must treat a job whose row was given up on as a no-op.
 */
export async function enqueueWithin<T>(queue: Queue<T>, name: string, data: T, opts: JobsOptions | undefined, timeoutMs: number): Promise<Job<T>> {
  return withinBudget(queue.name, () => (queue as unknown as Queue).add(name, data, opts) as unknown as Promise<Job<T>>, timeoutMs);
}

async function withinBudget<R>(queueName: string, add: () => Promise<R>, timeoutMs: number): Promise<R> {
  let timer: NodeJS.Timeout | undefined;
  const pending = add();
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueUnavailableException(queueName, `Redis did not accept the job within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([pending, late]);
  } catch (error) {
    if (error instanceof QueueUnavailableException) {
      logger.warn(`Queue ${queueName}: ${(error.getResponse() as { details: { reason: string } }).details.reason}`);
      // A late outcome of the abandoned add must not become an unhandled rejection.
      pending.catch((lateError: unknown) => logger.warn(`Queue ${queueName}: the abandoned add failed later: ${(lateError as Error)?.message ?? String(lateError)}`));
      throw error;
    }
    logger.warn(`Queue ${queueName}: add failed: ${(error as Error)?.message ?? String(error)}`);
    throw new QueueUnavailableException(queueName, (error as Error)?.message ?? 'add failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

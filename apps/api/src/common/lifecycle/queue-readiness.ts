import { INestApplicationContext, Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { QueueBase, Worker } from 'bullmq';

/**
 * Every BullMQ queue and worker registered in the application (roadmap 7.3).
 * bullmq opens its Redis connections in the constructor and never awaits
 * them, so "the application initialised" does not mean "the queues are
 * connected". The deployment code (boot, shutdown, readiness) and the
 * integration fixture both need the same list.
 */
export function queueInstances(modules: ModulesContainer): { queues: QueueBase[]; workers: Worker[] } {
  const queues: QueueBase[] = [];
  const workers: Worker[] = [];
  for (const module of modules.values()) {
    for (const wrapper of module.providers.values()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof QueueBase) queues.push(instance);
      else if (instance instanceof WorkerHost) {
        // The getter throws until BullMQ has created the worker (before onModuleInit).
        try {
          workers.push(instance.worker);
        } catch {
          // not created yet: nothing to wait for or close
        }
      }
    }
  }
  return { queues, workers };
}

/**
 * Resolves once every queue and worker connection is ready. Closing the
 * application inside that window makes each in-flight connect reject with
 * "Connection is closed", which bullmq re-emits as an 'error' event after its
 * listeners were removed: an unhandled error. Boot waits for it before
 * listening (bounded by `QUEUE_READY_TIMEOUT_MS`, after which the instance
 * serves anyway and readiness reports Redis down), the integration fixture
 * waits for it unbounded so a boot-assert-close suite is deterministic.
 */
export async function waitForQueueConnections(
  app: INestApplicationContext,
  options: { timeoutMs?: number; logger?: Logger } = {},
): Promise<boolean> {
  const { queues, workers } = queueInstances(app.get(ModulesContainer));
  const ready = Promise.all([...queues.map((q) => q.waitUntilReady()), ...workers.map((w) => w.waitUntilReady())]);
  if (options.timeoutMs === undefined) {
    await ready;
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), options.timeoutMs);
  });
  try {
    const result = await Promise.race([ready.then(() => true as const), timeout]);
    if (!result) {
      options.logger?.warn(
        `BullMQ connections (${queues.length} queue(s), ${workers.length} worker(s)) not ready after ${options.timeoutMs} ms; serving anyway, readiness reports Redis until it connects`,
      );
    } else {
      options.logger?.log(`BullMQ ready: ${queues.length} queue(s), ${workers.length} worker(s) connected`);
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    // A rejected connect after the timeout must not become an unhandled rejection.
    ready.catch(() => undefined);
  }
}

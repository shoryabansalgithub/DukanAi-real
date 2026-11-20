import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/**
 * Boot assertion (roadmap phase 4 exit gate): every registered BullMQ queue
 * has a worker in this process and every worker consumes a registered queue.
 * A queue without a consumer collects jobs in Redis for good (the former
 * `internal-events`, `inventory-events`, `customer-queue` and the dead
 * procurement processors did exactly that); a worker without a registration
 * cannot connect. The producer side (a queue nobody enqueues into) is
 * checked statically by `queue-wiring.spec.ts`.
 */
@Injectable()
export class QueueWiringAssertion implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueWiringAssertion.name);

  constructor(private readonly modules: ModulesContainer) {}

  onApplicationBootstrap(): void {
    const { queues, workers } = this.inventory();
    const problems: string[] = [];
    for (const queue of queues) {
      if (!workers.has(queue)) problems.push(`queue "${queue}" is registered but no @Processor consumes it`);
    }
    for (const worker of workers) {
      if (!queues.has(worker)) problems.push(`worker "${worker}" consumes a queue that is not registered`);
    }
    if (problems.length > 0) {
      throw new Error(`Queue wiring is broken (roadmap 4.6):\n  - ${problems.join('\n  - ')}`);
    }
    this.logger.log(`Queue wiring verified: ${queues.size} queues, each with a worker.`);
  }

  /** Names of every Queue provider and every WorkerHost's queue found in the container. */
  inventory(): { queues: Set<string>; workers: Set<string> } {
    const queues = new Set<string>();
    const workers = new Set<string>();
    for (const module of this.modules.values()) {
      for (const wrapper of module.providers.values()) {
        const instance: unknown = wrapper.instance;
        if (instance instanceof Queue) queues.add(instance.name);
        else if (instance instanceof WorkerHost && instance.worker) workers.add(instance.worker.name);
      }
    }
    return { queues, workers };
  }
}

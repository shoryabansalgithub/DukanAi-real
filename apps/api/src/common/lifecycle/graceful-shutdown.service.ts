import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { AppConfig } from '../../config/domains/app.config';
import { queueInstances } from './queue-readiness';

/**
 * Orders a graceful shutdown (roadmap 7.3). Nest runs `onModuleDestroy` on
 * every module, then `beforeApplicationShutdown`, then closes the HTTP and
 * socket servers (in-flight requests finish; idle keep-alive connections are
 * closed), then `onApplicationShutdown`. This hook is the second step:
 *
 *  1. readiness flips to 503 (`isDraining`), so a load balancer that polls
 *     `/api/health/ready` stops routing new requests here;
 *  2. on a real signal, the watchdog is armed: a drain still running after
 *     `SHUTDOWN_TIMEOUT_MS` exits 1 instead of waiting for SIGKILL;
 *  3. on a real signal, the process waits `SHUTDOWN_DRAIN_DELAY_MS` for the
 *     readiness change to propagate before the listener closes;
 *  4. every BullMQ worker is closed (no new job is taken, active jobs finish),
 *     so the queue, Redis and Prisma hooks that follow find no job in flight.
 *
 * `app.close()` without a signal (tests) skips the delay and the watchdog.
 * Prisma disconnects in `onApplicationShutdown`, after the server closed: it
 * used to disconnect in `onModuleDestroy`, before, failing in-flight requests.
 */
@Injectable()
export class GracefulShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);
  private draining = false;
  private watchdog?: NodeJS.Timeout;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly appConfig: AppConfig,
  ) {}

  /** True from the first shutdown request on; the readiness probe reads it. */
  get isDraining(): boolean {
    return this.draining;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.logger.log(`Shutdown requested${signal ? ` by ${signal}` : ''}: readiness answers 503, draining`);

    if (signal) {
      this.armWatchdog(signal);
      if (this.appConfig.shutdownDrainDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.appConfig.shutdownDrainDelayMs));
      }
    }

    const { workers } = queueInstances(this.modules);
    const results = await Promise.allSettled(workers.map((worker) => worker.close()));
    const failed = results.filter((r) => r.status === 'rejected').length;
    this.logger.log(`BullMQ workers closed (${workers.length - failed}/${workers.length}); closing the listener`);
  }

  private armWatchdog(signal: string): void {
    const timeoutMs = this.appConfig.shutdownTimeoutMs;
    this.watchdog = setTimeout(() => {
      this.logger.error(`Shutdown after ${signal} still draining after ${timeoutMs} ms; exiting`);
      process.exit(1);
    }, timeoutMs);
    // Never the reason the process stays alive once everything else is closed.
    this.watchdog.unref();
  }
}

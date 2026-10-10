import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { GracefulShutdownService } from '../common/lifecycle/graceful-shutdown.service';
import { MonitoringConfig } from '../config/domains/monitoring.config';

export type CheckStatus = 'up' | 'down';

export interface LivenessReport {
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
  /** The release this instance runs (`APP_RELEASE`, baked into release images; roadmap 9.21), null when unset. */
  release: string | null;
}

export interface ReadinessReport {
  /** `ok` is the only 200; `draining` is a terminating instance, `unavailable` a dependency failure. */
  status: 'ok' | 'draining' | 'unavailable';
  timestamp: string;
  checks: { database: CheckStatus; redis: CheckStatus };
}

/** A dependency that does not answer within this is reported down; the probe must answer well inside its own timeout. */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness for the orchestrator (roadmap 7.3). Liveness never
 * touches a dependency: a database outage must not restart every API
 * instance. Readiness proves the instance can serve a request now: the
 * database answers, the shared Redis client answers, and no shutdown is in
 * progress (`GracefulShutdownService`).
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly shutdown: GracefulShutdownService,
    private readonly monitoring: MonitoringConfig,
  ) {}

  liveness(): LivenessReport {
    return { status: 'ok', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), release: this.monitoring.appRelease || null };
  }

  async readiness(): Promise<ReadinessReport> {
    const timestamp = new Date().toISOString();
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
    ]);
    const checks = { database, redis };
    if (this.shutdown.isDraining) return { status: 'draining', timestamp, checks };
    return { status: database === 'up' && redis === 'up' ? 'ok' : 'unavailable', timestamp, checks };
  }

  private async probe(name: string, check: () => Promise<unknown>): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} check timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms`)), HEALTH_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([check(), timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(`Readiness: ${name} is down (${error instanceof Error ? error.message : String(error)})`);
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { HealthService, type LivenessReport, type ReadinessReport } from './health.service';

/**
 * Probe routes (roadmap 7.3), public and exempt from rate limiting so an
 * orchestrator polling every few seconds from one address is never throttled.
 *
 *  - `GET /api/health` and `GET /api/health/live`: liveness, always 200 while
 *    the process serves HTTP (the Playwright and compose health checks use the
 *    first).
 *  - `GET /api/health/ready`: readiness, 200 only when the database and
 *    Redis answer and no shutdown is in progress; 503 with the same body
 *    otherwise. Point the load balancer / Kubernetes readiness probe here.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  getHealth(): LivenessReport {
    return this.health.liveness();
  }

  @Get('live')
  getLive(): LivenessReport {
    return this.health.liveness();
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}

import { timingSafeEqual } from 'crypto';
import { Controller, Get, Header, Headers, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../auth/public.decorator';
import { MonitoringConfig } from '../../config/domains/monitoring.config';
import { metricsRegistry } from './metrics';
import { ObservabilityCollectorsService } from './observability-collectors.service';

/**
 * Prometheus scrape endpoint (roadmap 7.6): `GET /api/metrics`, text format.
 * Public to the guards (a scraper has no user) and exempt from rate limiting;
 * answers 404 when `METRICS_ENABLED=false` and 401 unless the bearer token
 * matches `METRICS_TOKEN` when one is set. Gauges are refreshed on each
 * scrape; counters and histograms are already current.
 */
@Controller('metrics')
@Public()
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly config: MonitoringConfig,
    private readonly collectors: ObservabilityCollectorsService,
  ) {}

  @Get()
  @Header('Content-Type', metricsRegistry.contentType)
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    if (!this.config.metricsEnabled) throw new NotFoundException();
    if (this.config.metricsToken) {
      const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      if (!presented || !tokenMatches(presented, this.config.metricsToken)) throw new UnauthorizedException('metrics token required');
    }
    await this.collectors.refresh();
    return metricsRegistry.metrics();
  }
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

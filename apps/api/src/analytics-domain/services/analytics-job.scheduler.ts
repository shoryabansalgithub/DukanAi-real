import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { KpiService } from './kpi.service';
import { ClassificationService } from './classification.service';
import { RecommendationEngineService } from './recommendation-engine.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronConfig } from '../../config/domains/cron.config';
import { CronLockService } from '../../common/cron-lock/cron-lock.service';
import { sweepEveryShop, SweepSummary } from '../../common/sweeps/per-shop-sweep';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

export const ANALYTICS_JOB = 'AnalyticsJob';
/** One pod runs the night; a lock this long outlives any realistic run of the tenant loop. */
const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Nightly inventory analytics (roadmap 4.9): KPI snapshot, ABC/XYZ
 * classification and recommendations, per shop, under one cron lock so a
 * multi-pod deployment computes each night once. Shops are visited in pages
 * inside their own tenant context (`sweepEveryShop`); a shop that fails is
 * logged and the others still run.
 */
@Injectable()
export class AnalyticsJobScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsJobScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kpiService: KpiService,
    private readonly classificationService: ClassificationService,
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly cronConfig: CronConfig,
    private readonly cronLock: CronLockService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn(`${ANALYTICS_JOB} schedule not registered: CRON_ENABLED=false`);
      return;
    }
    const job = new CronJob(this.cronConfig.analyticsJobCron, () => {
      this.handleCron().catch((error: unknown) => this.logger.error(`${ANALYTICS_JOB} crashed: ${(error as Error).message}`));
    });
    this.schedulerRegistry.addCronJob(ANALYTICS_JOB, job);
    job.start();
  }

  handleCron(): Promise<SweepSummary | null> {
    return this.cronLock.withLock('cron:analytics-job', LOCK_TTL_MS, () => this.runDailyAnalytics());
  }

  /** Every open shop, each in its own tenant context; returns the products classified per shop summed up. */
  runDailyAnalytics(now: Date = new Date()): Promise<SweepSummary> {
    return sweepEveryShop(this.prisma, this.tenantContext, this.logger, ANALYTICS_JOB, (shopId) => this.runForShop(shopId, now));
  }

  async runForShop(shopId: string, now: Date = new Date()): Promise<number> {
    await this.kpiService.calculateDailyKpis(shopId, now);
    const classification = await this.classificationService.classifyInventory(shopId, now);
    await this.recommendationEngine.generateRecommendations(shopId, now);
    return classification.products;
  }
}

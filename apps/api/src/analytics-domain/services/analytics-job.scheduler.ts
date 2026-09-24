import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { KpiService } from './kpi.service';
import { ClassificationService } from './classification.service';
import { ForecastService } from './forecast.service';
import { RecommendationEngineService } from './recommendation-engine.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronConfig } from '../../config/domains/cron.config';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

@Injectable()
export class AnalyticsJobScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsJobScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kpiService: KpiService,
    private readonly classificationService: ClassificationService,
    private readonly forecastService: ForecastService,
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContextService: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    const job = new CronJob(this.cronConfig.analyticsJobCron, () => {
      this.runDailyAnalytics().catch((error: unknown) => {
        this.logger.error(`Analytics job crashed: ${(error as Error).message}`);
      });
    });
    this.schedulerRegistry.addCronJob('AnalyticsJob', job);
    job.start();
  }

  /**
   * Main Analytics Orchestrator. Runs nightly for all tenants. There is no
   * request (hence no tenant context) here, so the body runs as super admin
   * and every service passes `shopId` explicitly.
   */
  async runDailyAnalytics() {
    this.logger.log('--- STARTING GLOBAL ENTERPRISE INVENTORY ANALYTICS JOB ---');

    await this.tenantContextService.runAsSuperAdmin(async () => {
      // In production, we'd paginate shops.
      const shops = await this.prisma.shop.findMany({ select: { id: true } });

      for (const shop of shops) {
        try {
          await this.kpiService.calculateDailyKpis(shop.id);
          await this.classificationService.classifyInventory(shop.id);
          await this.forecastService.generateForecasts(shop.id);
          await this.recommendationEngine.generateRecommendations(shop.id);
        } catch (error: unknown) {
          this.logger.error(`Analytics failed for shop ${shop.id}: ${(error as Error).message}`);
        }
      }
    });

    this.logger.log('--- GLOBAL ENTERPRISE INVENTORY ANALYTICS JOB COMPLETE ---');
  }
}

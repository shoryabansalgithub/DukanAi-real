import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { RevenueEngine } from './engines/revenue-engine';
import { ProfitMarginEngine } from './engines/profit-margin-engine';
import { TrendEngine } from './engines/trend-engine';
import { ForecastEngine } from './engines/forecast-engine';
import { AnalyticsCacheService } from './services/analytics-cache.service';
import { AnalyticsPageService } from './services/analytics-page.service';
import { DashboardService } from './services/dashboard.service';
import { DashboardInsightsService } from './services/dashboard-insights.service';
import { ReportExportService } from './services/report-export.service';
import { ShopTimezoneService } from './services/shop-timezone.service';
import { KpiService } from './services/kpi.service';
import { ClassificationService } from './services/classification.service';
import { RecommendationEngineService } from './services/recommendation-engine.service';
import { AnalyticsJobScheduler } from './services/analytics-job.scheduler';
import { AnalyticsController } from './analytics.controller';

/**
 * Dashboard & reports. Everything is computed live from Invoice /
 * InvoiceItem / InvoicePayment rows; the former BullMQ aggregation and export
 * queues (and the tables only they wrote) are no longer used. The nightly
 * job (`AnalyticsJobScheduler`, roadmap 4.9) writes the KPI snapshot, the
 * ABC/XYZ classes and the recommendations; the former forecast stub (a
 * logger call with no computation) is out of the chain.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController],
  providers: [
    RevenueEngine,
    ProfitMarginEngine,
    TrendEngine,
    ForecastEngine,
    AnalyticsCacheService,
    AnalyticsPageService,
    DashboardService,
    DashboardInsightsService,
    ReportExportService,
    ShopTimezoneService,
    KpiService,
    ClassificationService,
    RecommendationEngineService,
    AnalyticsJobScheduler,
  ],
  exports: [
    RevenueEngine,
    TrendEngine,
    KpiService,
    RecommendationEngineService,
    AnalyticsCacheService,
    ShopTimezoneService,
  ],
})
export class AnalyticsDomainModule {}

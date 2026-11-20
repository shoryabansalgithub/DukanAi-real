import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { FINANCE_ROLES } from '../auth/role-sets';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { AnalyticsDashboardService } from './services/analytics-dashboard.service';
import { AnalyticsVendorPerformanceService } from './services/analytics-vendor-performance.service';
import { AnalyticsTrendService } from './services/analytics-trend.service';
import { AnalyticsCostService } from './services/analytics-cost.service';

@Controller('purchase-analytics')
export class PurchaseAnalyticsController {
  constructor(
    private readonly dashboardService: AnalyticsDashboardService,
    private readonly vendorService: AnalyticsVendorPerformanceService,
    private readonly trendService: AnalyticsTrendService,
    private readonly costService: AnalyticsCostService
  ) {}

  @Roles(...FINANCE_ROLES)
  @Get('dashboard')
  async getDashboard(@CurrentShop() shopId: string, @Query('date') date?: string) {
    return this.dashboardService.getDashboardSnapshot(shopId, typeof date === 'string' && date.length > 0 ? date : undefined);
  }

  @Roles(...FINANCE_ROLES)
  @Get('kpis')
  async getKpis(@CurrentShop() shopId: string) {
    return this.dashboardService.getDashboardSnapshot(shopId);
  }

  @Roles(...FINANCE_ROLES)
  @Get('vendors')
  async getVendorPerformance(@CurrentShop() shopId: string) {
    return this.vendorService.getVendorRankings(shopId);
  }

  @Roles(...FINANCE_ROLES)
  @Get('trends')
  async getTrends(@CurrentShop() shopId: string, @Query('periodType') periodType: string = 'MONTHLY') {
    return this.trendService.getTrends(shopId, periodType);
  }

  @Roles(...FINANCE_ROLES)
  @Get('categories')
  async getCategorySpend(@CurrentShop() shopId: string) {
    return this.trendService.getCategorySpend(shopId);
  }

  @Roles(...FINANCE_ROLES)
  @Get('cost-analysis')
  async getCostAnalysis(@CurrentShop() shopId: string) {
    return this.costService.getCostAnalysis(shopId);
  }
}

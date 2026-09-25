import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../iam/guards/tenant.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { AnalyticsPageService } from './services/analytics-page.service';
import { DashboardService, MAX_LOW_STOCK_ITEMS } from './services/dashboard.service';
import { DashboardInsightsService } from './services/dashboard-insights.service';
import { CsvSink, ReportExportService } from './services/report-export.service';

const READ_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER, Role.VIEWER];
const EXPORT_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

function parseIntQuery(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Writes chunks to the Express response honouring backpressure, and fails
 * fast when the client goes away so a disconnected download cannot keep the
 * DB pagination running.
 */
function responseSink(res: Response): CsvSink {
  return (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      if (res.destroyed || res.writableEnded) {
        reject(new Error('Client disconnected'));
        return;
      }
      const onClose = () => {
        res.off('drain', onDrain);
        reject(new Error('Client disconnected'));
      };
      const onDrain = () => {
        res.off('close', onClose);
        resolve();
      };
      if (res.write(chunk)) {
        resolve();
      } else {
        res.once('drain', onDrain);
        res.once('close', onClose);
      }
    });
}

@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('dashboard')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly analyticsPage: AnalyticsPageService,
    private readonly dashboard: DashboardService,
    private readonly insights: DashboardInsightsService,
    private readonly exports: ReportExportService,
  ) {}

  /** Reports & Analytics page payload for a business-day range (today | week | month | year). */
  @Get('analytics')
  @Roles(...READ_ROLES)
  getAnalyticsPage(@CurrentShop() shopId: string, @Query('range') range?: string) {
    return this.analyticsPage.getAnalytics(shopId, range);
  }

  /** Today's headline KPIs, computed live and cached for `analyticsKpiTtlMs`. */
  @Get('kpis')
  @Roles(...READ_ROLES)
  getDashboardKpis(@CurrentShop() shopId: string) {
    return this.dashboard.getKpis(shopId);
  }

  /** Single tenant-scoped source for dashboard cards, recent activity and the caller's open shift. */
  @Get('summary')
  @Roles(...READ_ROLES)
  getDashboardSummary(@CurrentShop() shopId: string, @CurrentUser() user: SafeUserDto) {
    return this.dashboard.getSummary(shopId, user.id);
  }

  /** Stock alerts: counts plus the most urgent products (out of stock first); `limit` 1..500, default 100. */
  @Get('low-stock')
  @Roles(...READ_ROLES)
  getLowStock(@CurrentShop() shopId: string, @Query('limit') limit?: string) {
    const requested = parseIntQuery(limit, 100);
    return this.dashboard.lowStock(shopId, Math.max(1, Math.min(requested, MAX_LOW_STOCK_ITEMS)));
  }

  /** AI insights card: today's sales vs. forecast, restock suggestions, top product. */
  @Get('insights')
  @Roles(...READ_ROLES)
  getInsights(@CurrentShop() shopId: string) {
    return this.insights.getInsights(shopId);
  }

  /** Top products by gross profit over the last 30 business days. */
  @Get('products')
  @Roles(...READ_ROLES)
  getTopProducts(@CurrentShop() shopId: string, @Query('limit') limit?: string) {
    return this.dashboard.getTopProducts(shopId, limit ? parseIntQuery(limit, 0) : undefined);
  }

  /** Daily net-sales series for the last `days` business days (default 30). */
  @Get('trends')
  @Roles(...READ_ROLES)
  getRevenueTrends(@CurrentShop() shopId: string, @Query('days') days?: string) {
    return this.analyticsPage.getTrendSeries(shopId, parseIntQuery(days, 30));
  }

  /** 7-day moving average of net daily sales. */
  @Get('forecast')
  @Roles(...READ_ROLES)
  getRevenueForecast(@CurrentShop() shopId: string) {
    return this.dashboard.getForecast(shopId);
  }

  @Get('export/invoices.csv')
  @Roles(...EXPORT_ROLES)
  async exportInvoices(
    @CurrentShop() shopId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const range = await this.exports.resolveRange(shopId, from, to);
    await this.streamCsv(res, `invoices_${range.fromDate}_${range.toDate}.csv`, (sink) =>
      this.exports.streamInvoicesCsv(shopId, range, sink),
    );
  }

  @Get('export/invoice-items.csv')
  @Roles(...EXPORT_ROLES)
  async exportInvoiceItems(
    @CurrentShop() shopId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const range = await this.exports.resolveRange(shopId, from, to);
    await this.streamCsv(res, `invoice-items_${range.fromDate}_${range.toDate}.csv`, (sink) =>
      this.exports.streamInvoiceItemsCsv(shopId, range, sink),
    );
  }

  @Get('export/gst-summary.csv')
  @Roles(...EXPORT_ROLES)
  async exportGstSummary(
    @CurrentShop() shopId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const range = await this.exports.resolveRange(shopId, from, to);
    await this.streamCsv(res, `gst-summary_${range.fromDate}_${range.toDate}.csv`, (sink) =>
      this.exports.streamGstSummaryCsv(shopId, range, sink),
    );
  }

  /**
   * Sets the CSV headers and runs the producer. Range validation happens
   * before this is called so 400s still go through the global exception
   * filter; a failure after headers are sent can only abort the socket.
   */
  private async streamCsv(res: Response, filename: string, produce: (sink: CsvSink) => Promise<void>): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    try {
      await produce(responseSink(res));
      res.end();
    } catch (error) {
      this.logger.error(`CSV export ${filename} aborted: ${(error as Error).message}`);
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

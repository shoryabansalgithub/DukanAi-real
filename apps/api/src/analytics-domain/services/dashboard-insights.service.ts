import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString, endOfBusinessDay, startOfBusinessDay } from '../../common/time/business-day';
import { trailingBusinessDays } from '../analytics-range';
import { ForecastEngine, NetRevenueForecast } from '../engines/forecast-engine';
import { ProfitMarginEngine, TopProduct } from '../engines/profit-margin-engine';
import { RevenueEngine } from '../engines/revenue-engine';
import { completedInvoiceFilter, INVOICE_SIGN, toDecimal, toMoney } from '../engines/invoice-sql';
import { ShopTimezoneService } from './shop-timezone.service';
import { stockAlertProductFilter } from './dashboard.service';

/** Sales history the restock velocity is measured over (business days, today included). */
export const RESTOCK_BASIS_DAYS = 30;
/** Days of demand a suggested reorder should cover on top of the reorder point. */
export const RESTOCK_COVER_DAYS = 14;
/** A product selling faster than its stock covers this many days is flagged even above its reorder point. */
export const RESTOCK_WARN_COVER_DAYS = 7;
/** Days of cover below which a suggestion is CRITICAL. */
export const RESTOCK_CRITICAL_COVER_DAYS = 3;
export const RESTOCK_MAX_SUGGESTIONS = 5;
const RESTOCK_CANDIDATE_LIMIT = 200;

export type InsightSection = 'forecast' | 'restock' | 'topProduct';
export type RestockUrgency = 'OUT_OF_STOCK' | 'CRITICAL' | 'LOW';

export interface RestockSuggestion {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  currentStock: number;
  reorderPoint: number;
  /** Net units sold per business day over the basis window. */
  avgDailyUnits: number;
  /** currentStock / avgDailyUnits; null when the product did not sell in the window. */
  daysOfCover: number | null;
  suggestedQuantity: number;
  urgency: RestockUrgency;
  reason: string;
}

export interface SalesForecastInsight extends NetRevenueForecast {
  /** Net sales recorded so far in the current business day. */
  todayNetSales: number;
  /** todayNetSales as a percentage of the forecast; null without a forecast. */
  progressPct: number | null;
}

/**
 * Figures of a section listed in `failedSections` are null; every other
 * figure is computed live from committed invoices and product stock.
 */
export interface DashboardInsights {
  businessDate: string;
  generatedAt: string;
  failedSections: InsightSection[];
  forecast: SalesForecastInsight | null;
  restock: {
    basisDays: number;
    coverDays: number;
    items: RestockSuggestion[];
  } | null;
  /** Best product by gross profit over the last 30 business days. */
  topProduct: TopProduct | null;
}

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/** `GET /dashboard/insights`: the dashboard's AI insights card (contract §6). */
@Injectable()
export class DashboardInsightsService {
  private readonly logger = new Logger(DashboardInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueEngine: RevenueEngine,
    private readonly forecastEngine: ForecastEngine,
    private readonly profitMarginEngine: ProfitMarginEngine,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  async getInsights(shopId: string, now: Date = new Date()): Promise<DashboardInsights> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    const failed: InsightSection[] = [];
    const section = <T>(name: InsightSection, work: () => Promise<T>): Promise<T | null> =>
      // Promise.resolve().then: a synchronous throw is isolated like a rejection.
      Promise.resolve().then(work).catch((error: unknown) => {
        failed.push(name);
        this.logger.error(`Dashboard insight "${name}" failed for shop ${shopId}: ${(error as Error)?.message ?? error}`);
        return null;
      });

    const [forecast, restock, topProduct] = await Promise.all([
      section('forecast', () => this.salesForecast(shopId, timeZone, now)),
      section('restock', () => this.restockSuggestions(shopId, timeZone, now)),
      section('topProduct', async () => {
        const window = trailingBusinessDays(RESTOCK_BASIS_DAYS, timeZone, now);
        const [best] = await this.profitMarginEngine.getTopProductsByProfit(shopId, window.start, window.end, 1);
        return best && best.grossProfit > 0 ? best : null;
      }),
    ]);

    if (failed.length === 3) {
      throw new ServiceUnavailableException({ message: 'Insights are temporarily unavailable.', code: 'INSIGHTS_UNAVAILABLE' });
    }

    return {
      businessDate: businessDateString(now, timeZone),
      generatedAt: now.toISOString(),
      failedSections: (['forecast', 'restock', 'topProduct'] as const).filter((name) => failed.includes(name)),
      forecast,
      restock: restock ? { basisDays: RESTOCK_BASIS_DAYS, coverDays: RESTOCK_COVER_DAYS, items: restock } : null,
      topProduct,
    };
  }

  private async salesForecast(shopId: string, timeZone: string, now: Date): Promise<SalesForecastInsight> {
    const [forecast, today] = await Promise.all([
      this.forecastEngine.forecastNetRevenue(shopId, timeZone, now),
      this.revenueEngine.totals(shopId, startOfBusinessDay(now, timeZone), endOfBusinessDay(now, timeZone)),
    ]);
    const todayNetSales = toMoney(today.netSales);
    return {
      ...forecast,
      todayNetSales,
      progressPct: forecast.basisDays > 0 && forecast.forecastNetRevenue > 0
        ? Math.round((todayNetSales / forecast.forecastNetRevenue) * 100)
        : null,
    };
  }

  /**
   * Stock-tracked, active products that are out of stock, at or below their
   * reorder point, or selling fast enough to run out within
   * RESTOCK_WARN_COVER_DAYS. Suggested quantity refills to
   * reorderPoint + RESTOCK_COVER_DAYS days of net demand (or twice the
   * reorder point for a product without recent sales).
   */
  async restockSuggestions(shopId: string, timeZone: string, now: Date = new Date()): Promise<RestockSuggestion[]> {
    const window = trailingBusinessDays(RESTOCK_BASIS_DAYS, timeZone, now);
    const basis = window.days;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; sku: string; unit: string; currentStock: unknown; reorderPoint: unknown; units: unknown }>
    >`
      SELECT p.id, p.name, p.sku, p.unit, p.currentStock, p.reorderPoint, COALESCE(s.units, 0) AS units
      FROM Product p
      LEFT JOIN (
        SELECT ii.productId, SUM(${INVOICE_SIGN} * ii.quantity) AS units
        FROM InvoiceItem ii
        INNER JOIN Invoice i ON i.id = ii.invoiceId
        WHERE ${completedInvoiceFilter(shopId, window.start, window.end)}
          AND ii.isDeleted = false
          AND ii.productId IS NOT NULL
        GROUP BY ii.productId
      ) s ON s.productId = p.id
      WHERE ${stockAlertProductFilter(shopId)}
        AND (
          p.currentStock <= 0
          OR p.currentStock <= p.reorderPoint
          OR (COALESCE(s.units, 0) > 0 AND p.currentStock * ${basis} < ${RESTOCK_WARN_COVER_DAYS} * s.units)
        )
      ORDER BY
        CASE WHEN p.currentStock <= 0 THEN 0 ELSE 1 END ASC,
        CASE WHEN COALESCE(s.units, 0) > 0 THEN p.currentStock * ${basis} / s.units ELSE NULL END IS NULL ASC,
        CASE WHEN COALESCE(s.units, 0) > 0 THEN p.currentStock * ${basis} / s.units ELSE NULL END ASC,
        p.currentStock / NULLIF(p.reorderPoint, 0) ASC,
        p.name ASC
      LIMIT ${Prisma.raw(String(RESTOCK_CANDIDATE_LIMIT))}
    `;

    return rows
      .map((row) => this.toSuggestion(row, basis))
      .filter((s): s is RestockSuggestion => s !== null)
      .slice(0, RESTOCK_MAX_SUGGESTIONS);
  }

  private toSuggestion(
    row: { id: string; name: string; sku: string; unit: string; currentStock: unknown; reorderPoint: unknown; units: unknown },
    basisDays: number,
  ): RestockSuggestion | null {
    const stock = toDecimal(row.currentStock);
    const reorderPoint = Prisma.Decimal.max(toDecimal(row.reorderPoint), 0);
    const units = Prisma.Decimal.max(toDecimal(row.units), 0);
    const avgDaily = units.div(basisDays);
    const daysOfCover = avgDaily.greaterThan(0) ? Prisma.Decimal.max(stock, 0).div(avgDaily) : null;

    let target = avgDaily.greaterThan(0) ? reorderPoint.plus(avgDaily.times(RESTOCK_COVER_DAYS)) : reorderPoint.times(2);
    if (stock.lessThanOrEqualTo(0) && target.lessThan(1)) target = new Prisma.Decimal(1);
    const suggested = target.minus(stock).ceil();
    if (suggested.lessThanOrEqualTo(0)) return null;

    const perDay = round(avgDaily.toNumber(), 2);
    const unit = row.unit.toLowerCase();
    const cover = daysOfCover === null ? null : round(daysOfCover.toNumber(), 1);
    let urgency: RestockUrgency;
    let reason: string;
    if (stock.lessThanOrEqualTo(0)) {
      urgency = 'OUT_OF_STOCK';
      reason = perDay > 0 ? `Out of stock; sells about ${perDay} ${unit}/day` : 'Out of stock';
    } else if (cover !== null && cover < RESTOCK_CRITICAL_COVER_DAYS) {
      urgency = 'CRITICAL';
      reason = `About ${cover} days of stock left at ${perDay} ${unit}/day`;
    } else if (stock.lessThanOrEqualTo(reorderPoint)) {
      urgency = 'LOW';
      reason = cover !== null
        ? `At or below reorder point (${reorderPoint.toNumber()}); about ${cover} days of stock left`
        : `At or below reorder point (${reorderPoint.toNumber()})`;
    } else {
      urgency = 'LOW';
      reason = `Selling fast: about ${cover} days of stock left at ${perDay} ${unit}/day`;
    }

    return {
      productId: row.id,
      name: row.name,
      sku: row.sku,
      unit: row.unit,
      currentStock: stock.toNumber(),
      reorderPoint: reorderPoint.toNumber(),
      avgDailyUnits: perDay,
      daysOfCover: cover,
      suggestedQuantity: suggested.toNumber(),
      urgency,
      reason,
    };
  }
}

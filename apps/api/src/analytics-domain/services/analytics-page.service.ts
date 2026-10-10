import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevenueEngine } from '../engines/revenue-engine';
import { TrendEngine } from '../engines/trend-engine';
import { completedInvoiceFilter, INVOICE_SIGN, IS_SALE, pctChange, percentShare, toDecimal, toInt, toMoney } from '../engines/invoice-sql';
import { AnalyticsRange, businessDayLabel, MAX_TREND_DAYS, rangeDays, trailingBusinessDays } from '../analytics-range';
import { ShopTimezoneService } from './shop-timezone.service';

export type { AnalyticsRange } from '../analytics-range';

export interface TrendPoint {
  /** Chart label, e.g. `18 Sept`. */
  date: string;
  /** `YYYY-MM-DD` business date in the shop timezone. */
  businessDate: string;
  /** Net sales (sales minus returns). */
  sales: number;
}

export interface AnalyticsPagePayload {
  range: AnalyticsRange;
  timezone: string;
  from: string;
  to: string;
  kpis: {
    totalRevenue: number;
    netProfit: number;
    udharOutstanding: number;
    avgOrderValue: number;
    revenueChangePct: number | null;
    profitChangePct: number | null;
    aovChangePct: number | null;
  };
  revenueTrend: TrendPoint[];
  paymentModes: Array<{ name: string; value: number; amount: number }>;
  categorySales: Array<{ name: string; value: number; amount: number }>;
  topCustomers: Array<{ name: string; frequency: number; spent: number }>;
}

/**
 * Single payload backing the web Reports & Analytics page. Ranges are whole
 * business days in the shop timezone (today / last 7 / 30 / 365), every
 * figure applies the SALE / SALES_RETURN / CANCELLED rules of contract §6 and
 * nothing depends on background aggregation jobs.
 */
@Injectable()
export class AnalyticsPageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueEngine: RevenueEngine,
    private readonly trendEngine: TrendEngine,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  async getAnalytics(shopId: string, rangeInput: string | undefined): Promise<AnalyticsPagePayload> {
    const range: AnalyticsRange = rangeInput === 'today' || rangeInput === 'month' || rangeInput === 'year' ? rangeInput : 'week';
    const timeZone = await this.shopTimezone.resolve(shopId);
    const window = trailingBusinessDays(rangeDays(range), timeZone);
    const { start, end, prevStart } = window;

    const [current, previous, udhar, trend, paymentModes, categorySales, topCustomers] = await Promise.all([
      this.revenueAndProfit(shopId, start, end),
      this.revenueAndProfit(shopId, prevStart, start),
      this.prisma.customer.aggregate({ where: { shopId, isDeleted: false }, _sum: { outstandingBalance: true } }),
      this.trendSeries(shopId, start, end, timeZone),
      this.paymentModes(shopId, start, end),
      this.categorySales(shopId, start, end),
      this.topCustomers(shopId, start, end),
    ]);

    const avgOrderValue = current.orders > 0 ? current.revenue.div(current.orders) : new Prisma.Decimal(0);
    const prevAov = previous.orders > 0 ? previous.revenue.div(previous.orders) : new Prisma.Decimal(0);

    return {
      range,
      timezone: timeZone,
      from: window.fromDate,
      to: window.toDate,
      kpis: {
        totalRevenue: toMoney(current.revenue),
        netProfit: toMoney(current.profit),
        udharOutstanding: toMoney(udhar._sum.outstandingBalance ?? new Prisma.Decimal(0)),
        avgOrderValue: avgOrderValue.toDecimalPlaces(0).toNumber(),
        revenueChangePct: pctChange(current.revenue, previous.revenue),
        profitChangePct: pctChange(current.profit, previous.profit),
        aovChangePct: pctChange(avgOrderValue, prevAov),
      },
      revenueTrend: trend,
      paymentModes,
      categorySales,
      topCustomers,
    };
  }

  /** Chart-ready daily net-sales series for the last `days` business days. */
  async getTrendSeries(shopId: string, days: number): Promise<TrendPoint[]> {
    const safeDays = Math.min(Math.max(Number.isFinite(days) ? Math.floor(days) : 30, 1), MAX_TREND_DAYS);
    const timeZone = await this.shopTimezone.resolve(shopId);
    const { start, end } = trailingBusinessDays(safeDays, timeZone);
    return this.trendSeries(shopId, start, end, timeZone);
  }

  private async trendSeries(shopId: string, start: Date, end: Date, timeZone: string): Promise<TrendPoint[]> {
    const series = await this.trendEngine.dailyNetSales(shopId, start, end, timeZone);
    return series.map((day) => ({
      date: businessDayLabel(day.businessDate),
      businessDate: day.businessDate,
      sales: toMoney(day.sales),
    }));
  }

  private async revenueAndProfit(shopId: string, start: Date, end: Date) {
    const [totals, profit] = await Promise.all([
      this.revenueEngine.totals(shopId, start, end),
      this.revenueEngine.profit(shopId, start, end),
    ]);
    return { revenue: totals.netSales, profit, orders: totals.orders };
  }

  private async paymentModes(shopId: string, start: Date, end: Date) {
    const buckets = await this.revenueEngine.paymentModeBuckets(shopId, start, end);
    const total = buckets.reduce((acc, b) => acc.plus(b.amount), new Prisma.Decimal(0));
    return buckets.map((bucket) => ({
      name: bucket.mode,
      value: percentShare(bucket.amount, total),
      amount: toMoney(bucket.amount),
    }));
  }

  private async categorySales(shopId: string, start: Date, end: Date) {
    const rows = await this.prisma.$queryRaw<Array<{ name: string; total: unknown }>>`
      SELECT COALESCE(c.name, 'Uncategorised') AS name,
             COALESCE(SUM(${INVOICE_SIGN} * ii.totalAmount), 0) AS total
      FROM InvoiceItem ii
      INNER JOIN Invoice i ON i.id = ii.invoiceId
      LEFT JOIN Product p ON p.id = ii.productId
      LEFT JOIN Category c ON c.id = p.categoryId
      WHERE ${completedInvoiceFilter(shopId, start, end)}
        AND ii.isDeleted = false
      GROUP BY c.id, c.name
      ORDER BY total DESC
      LIMIT 6
    `;
    const amounts = rows.map((row) => ({ name: row.name, amount: toDecimal(row.total) }));
    const total = amounts.reduce((acc, r) => acc.plus(r.amount), new Prisma.Decimal(0));
    return amounts.map((row) => ({
      name: row.name,
      value: percentShare(row.amount, total),
      amount: toMoney(row.amount),
    }));
  }

  private async topCustomers(shopId: string, start: Date, end: Date) {
    const rows = await this.prisma.$queryRaw<Array<{ name: string; frequency: unknown; spent: unknown }>>`
      SELECT cu.name AS name,
             COALESCE(SUM(${IS_SALE}), 0) AS frequency,
             COALESCE(SUM(${INVOICE_SIGN} * i.totalAmount), 0) AS spent
      FROM Invoice i
      INNER JOIN Customer cu ON cu.id = i.customerId
      WHERE ${completedInvoiceFilter(shopId, start, end)}
      GROUP BY cu.id, cu.name
      ORDER BY spent DESC
      LIMIT 5
    `;
    return rows.map((row) => ({
      name: row.name,
      frequency: toInt(row.frequency),
      spent: toMoney(toDecimal(row.spent)),
    }));
  }
}

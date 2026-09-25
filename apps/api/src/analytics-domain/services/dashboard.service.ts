import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InvoiceStatus, Prisma, ShiftStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString, endOfBusinessDay, startOfBusinessDay } from '../../common/time/business-day';
import { trailingBusinessDays } from '../analytics-range';
import { RevenueEngine } from '../engines/revenue-engine';
import { ProfitMarginEngine, TopProduct } from '../engines/profit-margin-engine';
import { ForecastEngine, NetRevenueForecast } from '../engines/forecast-engine';
import { toDecimal, toInt, toMoney } from '../engines/invoice-sql';
import { AnalyticsCacheService } from './analytics-cache.service';
import { ShopTimezoneService } from './shop-timezone.service';

export interface DashboardShift {
  id: string;
  openedAt: Date;
  openingCash: number;
  expectedCash: number;
  totalSales: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  udharSales: number;
  totalReceipts: number;
}

/** Independently loaded parts of the summary; a failed part is reported, never fatal. */
export type DashboardSummarySection =
  | 'today'
  | 'todayProfit'
  | 'allTime'
  | 'customers'
  | 'products'
  | 'udhar'
  | 'stock'
  | 'inventoryValue'
  | 'recentInvoices'
  | 'paymentModes'
  | 'shift';

export const SUMMARY_SECTIONS: readonly DashboardSummarySection[] = [
  'today', 'todayProfit', 'allTime', 'customers', 'products', 'udhar',
  'stock', 'inventoryValue', 'recentInvoices', 'paymentModes', 'shift',
];

export type StockAlertStatus = 'OUT_OF_STOCK' | 'LOW_STOCK';

export interface LowStockItem {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  currentStock: number;
  reorderPoint: number;
  status: StockAlertStatus;
}

export interface LowStockList {
  lowStockCount: number;
  outOfStockCount: number;
  items: LowStockItem[];
}

/**
 * Figures of a section listed in `failedSections` are `null` (and lists are
 * empty); every other figure is authoritative.
 */
export interface DashboardSummary {
  businessDate: string;
  timezone: string;
  failedSections: DashboardSummarySection[];
  todayGrossSales: number | null;
  todayReturns: number | null;
  /** Net: gross sales minus returns. */
  todaySales: number | null;
  /** Gross profit: taxable value minus cost of goods, sales minus returns. */
  todayProfit: number | null;
  todayOrders: number | null;
  todayReturnCount: number | null;
  /** Net, all time. */
  totalRevenue: number | null;
  totalOrders: number | null;
  totalCustomers: number | null;
  totalProducts: number | null;
  outstandingUdhar: number | null;
  /** Active, stock-tracked products (not SERVICE/DIGITAL) with 0 < stock <= reorder point. */
  lowStockCount: number | null;
  /** Active, stock-tracked products with stock <= 0. */
  outOfStockCount: number | null;
  /** Most urgent stock alerts (out of stock first), at most `SUMMARY_LOW_STOCK_ITEMS`. */
  lowStockItems: LowStockItem[];
  inventoryValue: number | null;
  recentInvoices: Array<{
    id: string;
    invoiceNumber: string;
    type: string;
    status: string;
    totalAmount: number;
    paymentMode: string;
    createdAt: Date;
    customer: { id: string; name: string } | null;
  }>;
  /** Today's takings per tender, net of refunds: the buckets add up to today's net sales. */
  paymentModes: Array<{ mode: string; amount: number }>;
  shift: DashboardShift | null;
}

export interface DashboardKpis {
  businessDate: string;
  grossRevenue: number;
  netRevenue: number;
  totalRefunds: number;
  orders: number;
  avgOrderValue: number;
}

const TOP_PRODUCTS_WINDOW_DAYS = 30;
export const SUMMARY_LOW_STOCK_ITEMS = 5;
export const MAX_LOW_STOCK_ITEMS = 500;

/**
 * Products that can raise a stock alert: not deleted, active (the same rule
 * the POS uses to sell), and stock-tracked (the inventory engine bypasses
 * SERVICE and DIGITAL products, so their stock is always 0).
 */
export function stockAlertProductFilter(shopId: string, alias = 'p'): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}.shopId = ${shopId} AND ${a}.isDeleted = false AND ${a}.isActive = true AND ${a}.type NOT IN ('SERVICE', 'DIGITAL')`;
}

/** Contract §6 `GET /dashboard/summary`, `/kpis`, `/products`, `/forecast`. */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueEngine: RevenueEngine,
    private readonly profitMarginEngine: ProfitMarginEngine,
    private readonly forecastEngine: ForecastEngine,
    private readonly cache: AnalyticsCacheService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  async getSummary(shopId: string, userId: string): Promise<DashboardSummary> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    const now = new Date();
    const start = startOfBusinessDay(now, timeZone);
    const end = endOfBusinessDay(now, timeZone);

    const failed: DashboardSummarySection[] = [];
    const section = <T>(name: DashboardSummarySection, work: () => Promise<T>): Promise<T | null> =>
      // Promise.resolve().then: a synchronous throw is isolated like a rejection.
      Promise.resolve().then(work).catch((error: unknown) => {
        failed.push(name);
        this.logger.error(`Dashboard summary section "${name}" failed for shop ${shopId}: ${(error as Error)?.message ?? error}`);
        return null;
      });

    const [
      today,
      allTime,
      todayProfit,
      customerCount,
      productCount,
      udharAgg,
      recentInvoices,
      paymentBuckets,
      stock,
      inventoryValue,
      shift,
    ] = await Promise.all([
      section('today', () => this.revenueEngine.totals(shopId, start, end)),
      section('allTime', () => this.revenueEngine.totals(shopId)),
      section('todayProfit', () => this.revenueEngine.profit(shopId, start, end)),
      section('customers', () => this.prisma.customer.count({ where: { shopId, isDeleted: false } })),
      section('products', () => this.prisma.product.count({ where: { shopId, isDeleted: false } })),
      section('udhar', () =>
        this.prisma.customer.aggregate({ where: { shopId, isDeleted: false }, _sum: { outstandingBalance: true } }),
      ),
      section('recentInvoices', () =>
        this.prisma.invoice.findMany({
          where: { shopId, isDeleted: false, status: { in: [InvoiceStatus.COMPLETED, InvoiceStatus.CANCELLED] } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            invoiceNumber: true,
            type: true,
            status: true,
            totalAmount: true,
            paymentMode: true,
            createdAt: true,
            customer: { select: { id: true, name: true } },
          },
        }),
      ),
      section('paymentModes', () => this.revenueEngine.paymentModeBuckets(shopId, start, end, { netOfRefunds: true })),
      section('stock', () => this.lowStock(shopId, SUMMARY_LOW_STOCK_ITEMS)),
      section('inventoryValue', () => this.inventoryValue(shopId)),
      section('shift', () =>
        this.prisma.shift.findFirst({
          where: { shopId, openedById: userId, status: ShiftStatus.OPEN, isDeleted: false },
          orderBy: { openedAt: 'desc' },
        }),
      ),
    ]);

    // Nothing could be read (e.g. the database is down): that is an outage,
    // not a partial dashboard.
    if (failed.length === SUMMARY_SECTIONS.length) {
      throw new ServiceUnavailableException({
        message: 'Dashboard data is temporarily unavailable.',
        code: 'DASHBOARD_UNAVAILABLE',
      });
    }

    const money = (value: Prisma.Decimal | null) => (value === null ? null : toMoney(value));

    return {
      businessDate: businessDateString(now, timeZone),
      timezone: timeZone,
      failedSections: SUMMARY_SECTIONS.filter((name) => failed.includes(name)),
      todayGrossSales: today ? toMoney(today.grossSales) : null,
      todayReturns: today ? toMoney(today.returns) : null,
      todaySales: today ? toMoney(today.netSales) : null,
      todayProfit: money(todayProfit),
      todayOrders: today ? today.orders : null,
      todayReturnCount: today ? today.returnCount : null,
      totalRevenue: allTime ? toMoney(allTime.netSales) : null,
      totalOrders: allTime ? allTime.orders : null,
      totalCustomers: customerCount,
      totalProducts: productCount,
      outstandingUdhar: udharAgg ? toMoney(udharAgg._sum.outstandingBalance ?? new Prisma.Decimal(0)) : null,
      lowStockCount: stock ? stock.lowStockCount : null,
      outOfStockCount: stock ? stock.outOfStockCount : null,
      lowStockItems: stock ? stock.items : [],
      inventoryValue: money(inventoryValue),
      recentInvoices: (recentInvoices ?? []).map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        type: invoice.type,
        status: invoice.status,
        totalAmount: toMoney(invoice.totalAmount),
        paymentMode: invoice.paymentMode,
        createdAt: invoice.createdAt,
        customer: invoice.customer,
      })),
      paymentModes: (paymentBuckets ?? []).map((bucket) => ({ mode: bucket.mode, amount: toMoney(bucket.amount) })),
      shift: shift
        ? {
            id: shift.id,
            openedAt: shift.openedAt,
            openingCash: toMoney(shift.openingCash),
            expectedCash: toMoney(shift.expectedCash),
            totalSales: toMoney(shift.totalSales),
            cashSales: toMoney(shift.cashSales),
            upiSales: toMoney(shift.upiSales),
            cardSales: toMoney(shift.cardSales),
            udharSales: toMoney(shift.udharSales),
            totalReceipts: toMoney(shift.totalReceipts),
          }
        : null,
    };
  }

  /** Today's headline figures, cached under `shop:{shopId}:analytics:kpis`. */
  async getKpis(shopId: string): Promise<DashboardKpis> {
    const cached = await this.cache.getKpis<DashboardKpis>(shopId);
    if (cached) return cached;

    const timeZone = await this.shopTimezone.resolve(shopId);
    const now = new Date();
    const totals = await this.revenueEngine.totals(
      shopId,
      startOfBusinessDay(now, timeZone),
      endOfBusinessDay(now, timeZone),
    );
    // Net sales per order, the same basis as the Reports page.
    const avgOrderValue = totals.orders > 0 ? totals.netSales.div(totals.orders) : new Prisma.Decimal(0);

    const kpis: DashboardKpis = {
      businessDate: businessDateString(now, timeZone),
      grossRevenue: toMoney(totals.grossSales),
      netRevenue: toMoney(totals.netSales),
      totalRefunds: toMoney(totals.returns),
      orders: totals.orders,
      avgOrderValue: toMoney(avgOrderValue),
    };
    await this.cache.setKpis(shopId, kpis);
    return kpis;
  }

  /** Top products by gross profit over the last 30 business days. */
  async getTopProducts(shopId: string, limit?: number): Promise<TopProduct[]> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    const { start, end } = trailingBusinessDays(TOP_PRODUCTS_WINDOW_DAYS, timeZone);
    return this.profitMarginEngine.getTopProductsByProfit(shopId, start, end, limit);
  }

  async getForecast(shopId: string): Promise<NetRevenueForecast> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    return this.forecastEngine.forecastNetRevenue(shopId, timeZone);
  }

  /**
   * Stock alerts of the shop: counts over every alerting product plus the
   * `limit` most urgent ones (out of stock first, then lowest stock relative
   * to the reorder point). `limit` is clamped to [0, MAX_LOW_STOCK_ITEMS].
   */
  async lowStock(shopId: string, limit: number): Promise<LowStockList> {
    const take = Math.max(0, Math.min(Math.floor(Number.isFinite(limit) ? limit : 0), MAX_LOW_STOCK_ITEMS));
    const filter = stockAlertProductFilter(shopId);
    const [counts, rows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ lowStock: unknown; outOfStock: unknown }>>`
        SELECT
          COALESCE(SUM(CASE WHEN p.currentStock > 0 AND p.currentStock <= p.reorderPoint THEN 1 ELSE 0 END), 0) AS lowStock,
          COALESCE(SUM(CASE WHEN p.currentStock <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock
        FROM Product p
        WHERE ${filter}
      `,
      take === 0
        ? Promise.resolve([])
        : this.prisma.$queryRaw<
            Array<{ id: string; name: string; sku: string; unit: string; currentStock: unknown; reorderPoint: unknown }>
          >`
            SELECT p.id, p.name, p.sku, p.unit, p.currentStock, p.reorderPoint
            FROM Product p
            WHERE ${filter} AND (p.currentStock <= 0 OR p.currentStock <= p.reorderPoint)
            ORDER BY
              CASE WHEN p.currentStock <= 0 THEN 0 ELSE 1 END ASC,
              p.currentStock / NULLIF(p.reorderPoint, 0) ASC,
              p.name ASC,
              p.id ASC
            LIMIT ${Prisma.raw(String(take))}
          `,
    ]);
    return {
      lowStockCount: toInt(counts[0]?.lowStock),
      outOfStockCount: toInt(counts[0]?.outOfStock),
      items: rows.map((row) => {
        const currentStock = toDecimal(row.currentStock);
        return {
          productId: row.id,
          name: row.name,
          sku: row.sku,
          unit: row.unit,
          currentStock: currentStock.toNumber(),
          reorderPoint: toDecimal(row.reorderPoint).toNumber(),
          status: currentStock.lessThanOrEqualTo(0) ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        };
      }),
    };
  }

  /** SUM(InventoryItem.onHand x Product.costPrice); InventoryItem is not tenant-scoped, hence explicit shopId. */
  private async inventoryValue(shopId: string): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<Array<{ value: unknown }>>`
      SELECT COALESCE(SUM(inv.onHand * p.costPrice), 0) AS value
      FROM InventoryItem inv
      INNER JOIN Product p ON p.id = inv.productId
      WHERE inv.shopId = ${shopId}
        AND inv.isDeleted = false
        AND p.isDeleted = false
    `;
    return toDecimal(rows[0]?.value);
  }
}

import { Injectable } from '@nestjs/common';
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

export interface DashboardSummary {
  businessDate: string;
  timezone: string;
  todayGrossSales: number;
  todayReturns: number;
  /** Net: gross sales minus returns. */
  todaySales: number;
  todayProfit: number;
  todayOrders: number;
  todayReturnCount: number;
  /** Net, all time. */
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  outstandingUdhar: number;
  lowStockCount: number;
  outOfStockCount: number;
  inventoryValue: number;
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

/** Contract §6 `GET /dashboard/summary`, `/kpis`, `/products`, `/forecast`. */
@Injectable()
export class DashboardService {
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

    const [
      today,
      allTime,
      todayProfit,
      customerCount,
      productCount,
      udharAgg,
      recentInvoices,
      paymentBuckets,
      stockStats,
      inventoryValue,
      shift,
    ] = await Promise.all([
      this.revenueEngine.totals(shopId, start, end),
      this.revenueEngine.totals(shopId),
      this.revenueEngine.profit(shopId, start, end),
      this.prisma.customer.count({ where: { shopId, isDeleted: false } }),
      this.prisma.product.count({ where: { shopId, isDeleted: false } }),
      this.prisma.customer.aggregate({ where: { shopId, isDeleted: false }, _sum: { outstandingBalance: true } }),
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
      this.revenueEngine.paymentModeBuckets(shopId, start, end),
      this.stockCounts(shopId),
      this.inventoryValue(shopId),
      this.prisma.shift.findFirst({
        where: { shopId, openedById: userId, status: ShiftStatus.OPEN, isDeleted: false },
        orderBy: { openedAt: 'desc' },
      }),
    ]);

    return {
      businessDate: businessDateString(now, timeZone),
      timezone: timeZone,
      todayGrossSales: toMoney(today.grossSales),
      todayReturns: toMoney(today.returns),
      todaySales: toMoney(today.netSales),
      todayProfit: toMoney(todayProfit),
      todayOrders: today.orders,
      todayReturnCount: today.returnCount,
      totalRevenue: toMoney(allTime.netSales),
      totalOrders: allTime.orders,
      totalCustomers: customerCount,
      totalProducts: productCount,
      outstandingUdhar: toMoney(udharAgg._sum.outstandingBalance ?? new Prisma.Decimal(0)),
      lowStockCount: stockStats.lowStock,
      outOfStockCount: stockStats.outOfStock,
      inventoryValue: toMoney(inventoryValue),
      recentInvoices: recentInvoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        type: invoice.type,
        status: invoice.status,
        totalAmount: toMoney(invoice.totalAmount),
        paymentMode: invoice.paymentMode,
        createdAt: invoice.createdAt,
        customer: invoice.customer,
      })),
      paymentModes: paymentBuckets.map((bucket) => ({ mode: bucket.mode, amount: toMoney(bucket.amount) })),
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
    const avgOrderValue = totals.orders > 0 ? totals.grossSales.div(totals.orders) : new Prisma.Decimal(0);

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

  private async stockCounts(shopId: string): Promise<{ lowStock: number; outOfStock: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ lowStock: unknown; outOfStock: unknown }>>`
      SELECT
        COALESCE(SUM(CASE WHEN currentStock <= reorderPoint AND currentStock > 0 THEN 1 ELSE 0 END), 0) AS lowStock,
        COALESCE(SUM(CASE WHEN currentStock <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock
      FROM Product
      WHERE shopId = ${shopId} AND isDeleted = false
    `;
    return { lowStock: toInt(rows[0]?.lowStock), outOfStock: toInt(rows[0]?.outOfStock) };
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

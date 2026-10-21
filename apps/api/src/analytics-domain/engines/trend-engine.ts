import { Injectable } from '@nestjs/common';
import { InvoiceStatus, InvoiceType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString } from '../../common/time/business-day';
import { enumerateBusinessDays, hasUniformOffset, mysqlOffsetAt } from '../analytics-range';
import { completedInvoiceFilter, INVOICE_SIGN, toDecimal } from './invoice-sql';

export interface DailyNetSales {
  /** `YYYY-MM-DD` business date in the shop timezone. */
  businessDate: string;
  /** Sales minus returns for that business day. */
  sales: Prisma.Decimal;
}

/**
 * Daily net-sales series bucketed by business day in the shop timezone.
 * Nothing here reads the aggregation tables; it is computed live.
 */
@Injectable()
export class TrendEngine {
  constructor(private readonly prisma: PrismaService) {}

  /** Only the business days in [start, end) that have at least one COMPLETED invoice. */
  async dailyNetSalesSparse(shopId: string, start: Date, end: Date, timeZone: string): Promise<DailyNetSales[]> {
    // The SQL day key uses a fixed UTC offset; when a DST switch falls inside
    // the range that offset is not constant, so bucket in JS instead.
    if (!hasUniformOffset(start, end, timeZone)) {
      return this.bucketInJs(shopId, start, end, timeZone);
    }

    const offset = mysqlOffsetAt(start, timeZone);
    const rows = await this.prisma.$queryRaw<Array<{ day: string; sales: unknown }>>`
      SELECT
        DATE_FORMAT(CONVERT_TZ(i.createdAt, '+00:00', ${offset}), '%Y-%m-%d') AS day,
        COALESCE(SUM(${INVOICE_SIGN} * i.totalAmount), 0) AS sales
      FROM Invoice i
      WHERE ${completedInvoiceFilter(shopId, start, end)}
      GROUP BY day
      ORDER BY day ASC
    `;
    return rows.map((row) => ({ businessDate: row.day, sales: toDecimal(row.sales) }));
  }

  /** Every business day in [start, end), zero-filled, in ascending order. */
  async dailyNetSales(shopId: string, start: Date, end: Date, timeZone: string): Promise<DailyNetSales[]> {
    const sparse = await this.dailyNetSalesSparse(shopId, start, end, timeZone);
    const byDay = new Map(sparse.map((row) => [row.businessDate, row.sales]));
    return enumerateBusinessDays(start, end, timeZone).map((businessDate) => ({
      businessDate,
      sales: byDay.get(businessDate) ?? new Prisma.Decimal(0),
    }));
  }

  private async bucketInJs(shopId: string, start: Date, end: Date, timeZone: string): Promise<DailyNetSales[]> {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        shopId,
        status: InvoiceStatus.COMPLETED,
        isDeleted: false,
        type: { in: [InvoiceType.SALE, InvoiceType.SALES_RETURN] },
        createdAt: { gte: start, lt: end },
      },
      select: { createdAt: true, totalAmount: true, type: true },
    });

    const totals = new Map<string, Prisma.Decimal>();
    for (const invoice of invoices) {
      const key = businessDateString(invoice.createdAt, timeZone);
      const signed = invoice.type === InvoiceType.SALE ? invoice.totalAmount : invoice.totalAmount.negated();
      totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).plus(signed));
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([businessDate, sales]) => ({ businessDate, sales }));
  }
}

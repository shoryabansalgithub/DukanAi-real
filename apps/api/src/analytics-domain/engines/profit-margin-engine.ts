import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsFeatureConfig } from '../../config/domains/features/analytics-feature.config';
import { completedInvoiceFilter, INVOICE_SIGN, ITEM_PROFIT, ITEM_TAXABLE, toDecimal, toMoney } from './invoice-sql';

export interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  unitsSold: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
}

const MAX_TOP_PRODUCTS = 100;

@Injectable()
export class ProfitMarginEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsConfig: AnalyticsFeatureConfig,
  ) {}

  /** Gross Margin % = grossProfit / netRevenue * 100 (2 dp), 0 when there is no revenue. */
  calculateMargins(grossProfit: Prisma.Decimal, netRevenue: Prisma.Decimal): { grossMarginPct: number } {
    if (netRevenue.lessThanOrEqualTo(0)) return { grossMarginPct: 0 };
    return { grossMarginPct: grossProfit.div(netRevenue).mul(100).toDecimalPlaces(2).toNumber() };
  }

  /**
   * Top products by gross profit, computed live from InvoiceItem rows in
   * [start, end): sale lines count positive, return lines negative.
   */
  async getTopProductsByProfit(shopId: string, start: Date, end: Date, limit?: number): Promise<TopProduct[]> {
    const requested = limit && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : this.analyticsConfig.topProductsLimit;
    // Bounded integer only: it is inlined into the SQL text below, never a user string.
    const finalLimit = Math.max(1, Math.min(Math.floor(requested) || 1, MAX_TOP_PRODUCTS));

    const rows = await this.prisma.$queryRaw<
      Array<{ productId: string; name: string; sku: string; unitsSold: unknown; netRevenue: unknown; cogs: unknown; grossProfit: unknown }>
    >`
      SELECT
        p.id   AS productId,
        p.name AS name,
        p.sku  AS sku,
        COALESCE(SUM(${INVOICE_SIGN} * ii.quantity), 0)                 AS unitsSold,
        COALESCE(SUM(${INVOICE_SIGN} * ${ITEM_TAXABLE}), 0)             AS netRevenue,
        COALESCE(SUM(${INVOICE_SIGN} * ii.costPrice * ii.quantity), 0)  AS cogs,
        COALESCE(SUM(${INVOICE_SIGN} * ${ITEM_PROFIT}), 0)              AS grossProfit
      FROM InvoiceItem ii
      INNER JOIN Invoice i ON i.id = ii.invoiceId
      INNER JOIN Product p ON p.id = ii.productId
      WHERE ${completedInvoiceFilter(shopId, start, end)}
        AND ii.isDeleted = false
      GROUP BY p.id, p.name, p.sku
      ORDER BY grossProfit DESC
      LIMIT ${Prisma.raw(String(finalLimit))}
    `;

    return rows.map((row) => {
      const netRevenue = toDecimal(row.netRevenue);
      const grossProfit = toDecimal(row.grossProfit);
      return {
        productId: row.productId,
        name: row.name,
        sku: row.sku,
        unitsSold: toDecimal(row.unitsSold).toDecimalPlaces(3).toNumber(),
        netRevenue: toMoney(netRevenue),
        cogs: toMoney(toDecimal(row.cogs)),
        grossProfit: toMoney(grossProfit),
        ...this.calculateMargins(grossProfit, netRevenue),
      };
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString } from '../../common/time/business-day';
import { trailingBusinessDays, utcMidnightOfBusinessDate } from '../analytics-range';
import { completedInvoiceFilter, INVOICE_SIGN, toDecimal } from '../engines/invoice-sql';
import { ShopTimezoneService } from './shop-timezone.service';

const SALES_WINDOW_DAYS = 30;
const MAX_DAYS_OF_INVENTORY = new Prisma.Decimal(999);
const MIN_AVG_DAILY_UNITS = new Prisma.Decimal('0.01');
const ONE = new Prisma.Decimal(1);

function maxDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.greaterThan(b) ? a : b;
}

function minDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.lessThan(b) ? a : b;
}

/** 0-100 stockout risk from days of inventory: <3 -> 90, <7 -> 60, <14 -> 30, else 10. */
export function stockoutRiskScore(daysOfInventory: Prisma.Decimal): number {
  if (daysOfInventory.lessThan(3)) return 90;
  if (daysOfInventory.lessThan(7)) return 60;
  if (daysOfInventory.lessThan(14)) return 30;
  return 10;
}

/** The `@db.Date` value every nightly KPI/recommendation row uses for "today" in the shop timezone. */
export function kpiDateFor(now: Date, timeZone: string): Date {
  return utcMidnightOfBusinessDate(businessDateString(now, timeZone));
}

@Injectable()
export class KpiService {
  private readonly logger = new Logger(KpiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  /**
   * Calculates the daily inventory KPI snapshot for every product in a shop:
   * stock value at cost, 30-day turnover, days of inventory and stockout risk.
   * Runs from the nightly job (inside `runAsSuperAdmin`), never in a request.
   */
  async calculateDailyKpis(shopId: string, now: Date = new Date()) {
    this.logger.log(`Starting Daily KPI Calculation for shop ${shopId}...`);

    const timeZone = await this.shopTimezone.resolve(shopId);
    const date = kpiDateFor(now, timeZone);
    const { start, end } = trailingBusinessDays(SALES_WINDOW_DAYS, timeZone, now);

    const [products, onHandRows, soldRows] = await Promise.all([
      this.prisma.product.findMany({
        where: { shopId, isDeleted: false },
        select: { id: true, costPrice: true },
      }),
      // InventoryItem is not tenant-scoped by the Prisma extension: explicit shopId.
      this.prisma.inventoryItem.groupBy({
        by: ['productId'],
        where: { shopId, isDeleted: false },
        _sum: { onHand: true },
      }),
      this.prisma.$queryRaw<Array<{ productId: string; units: unknown }>>`
        SELECT ii.productId AS productId, COALESCE(SUM(${INVOICE_SIGN} * ii.quantity), 0) AS units
        FROM InvoiceItem ii
        INNER JOIN Invoice i ON i.id = ii.invoiceId
        WHERE ${completedInvoiceFilter(shopId, start, end)}
          AND ii.isDeleted = false
        GROUP BY ii.productId
      `,
    ]);

    const onHandByProduct = new Map(onHandRows.map((row) => [row.productId, row._sum.onHand ?? new Prisma.Decimal(0)]));
    const unitsByProduct = new Map(soldRows.map((row) => [row.productId, toDecimal(row.units)]));

    for (const product of products) {
      const onHand = maxDecimal(onHandByProduct.get(product.id) ?? new Prisma.Decimal(0), new Prisma.Decimal(0));
      const unitsSold = maxDecimal(unitsByProduct.get(product.id) ?? new Prisma.Decimal(0), new Prisma.Decimal(0));

      const totalValue = onHand.mul(product.costPrice).toDecimalPlaces(4);
      const turnoverRate = unitsSold.div(maxDecimal(onHand, ONE)).toDecimalPlaces(4);
      const avgDailyUnits = unitsSold.div(SALES_WINDOW_DAYS);
      const daysOfInventory = minDecimal(onHand.div(maxDecimal(avgDailyUnits, MIN_AVG_DAILY_UNITS)), MAX_DAYS_OF_INVENTORY).toDecimalPlaces(2);
      const risk = stockoutRiskScore(daysOfInventory);

      await this.prisma.inventoryKpi.upsert({
        where: { shopId_productId_date: { shopId, productId: product.id, date } },
        update: { totalValue, turnoverRate, daysOfInventory, stockoutRiskScore: risk },
        create: { shopId, productId: product.id, date, totalValue, turnoverRate, daysOfInventory, stockoutRiskScore: risk },
      });
    }

    this.logger.log(`Completed KPI calculations for ${products.length} products.`);
  }
}

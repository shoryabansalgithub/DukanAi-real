import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { trailingBusinessDays } from '../analytics-range';
import { chunk } from '../engines/batch-write';
import { CLASSIFICATION_WEEKS, CLASSIFICATION_WINDOW_DAYS, classifyProducts, ProductSales } from '../engines/classification-engine';
import { completedInvoiceFilter, INVOICE_SIGN, ITEM_TAXABLE, toDecimal, toInt } from '../engines/invoice-sql';
import { ShopTimezoneService } from './shop-timezone.service';

const WEEK_SECONDS = 7 * 24 * 3600;

export interface ClassificationRun {
  products: number;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Nightly ABC / XYZ classification (roadmap 4.9). Every live product of the
 * shop gets exactly one InventoryClassification row computed from the last
 * CLASSIFICATION_WEEKS business weeks of COMPLETED sales net of returns
 * (contract §6 rules via `completedInvoiceFilter`); the math is in
 * `engines/classification-engine.ts`. Rows are written in multi-row
 * `INSERT ... ON DUPLICATE KEY UPDATE` batches on the `(shopId, productId)`
 * key, so a re-run of the same night is idempotent and a shop with thousands
 * of products costs a handful of statements, not one round trip per product.
 * Runs per shop from `AnalyticsJobScheduler` inside that shop's tenant context.
 */
@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  async classifyInventory(shopId: string, now: Date = new Date()): Promise<ClassificationRun> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    const { start, end } = trailingBusinessDays(CLASSIFICATION_WINDOW_DAYS, timeZone, now);

    const [products, salesRows] = await Promise.all([
      this.prisma.product.findMany({ where: { shopId, isDeleted: false }, select: { id: true }, orderBy: { id: 'asc' } }),
      this.prisma.$queryRaw<Array<{ productId: string; week: unknown; units: unknown; revenue: unknown }>>`
        SELECT ii.productId AS productId,
               FLOOR(TIMESTAMPDIFF(SECOND, ${start}, i.createdAt) / ${WEEK_SECONDS}) AS week,
               COALESCE(SUM(${INVOICE_SIGN} * ii.quantity), 0) AS units,
               COALESCE(SUM(${INVOICE_SIGN} * ${ITEM_TAXABLE}), 0) AS revenue
        FROM InvoiceItem ii
        INNER JOIN Invoice i ON i.id = ii.invoiceId
        WHERE ${completedInvoiceFilter(shopId, start, end)}
          AND ii.isDeleted = false
          AND ii.productId IS NOT NULL
        GROUP BY ii.productId, week
      `,
    ]);

    const sales = new Map<string, ProductSales>();
    for (const product of products) {
      sales.set(product.id, { productId: product.id, revenue: new Prisma.Decimal(0), weeklyUnits: new Array<number>(CLASSIFICATION_WEEKS).fill(0) });
    }
    for (const row of salesRows) {
      const entry = sales.get(row.productId);
      if (!entry) continue; // sold, but deleted since: not classified
      const week = Math.min(Math.max(toInt(row.week), 0), CLASSIFICATION_WEEKS - 1);
      entry.weeklyUnits[week] += toDecimal(row.units).toNumber();
      entry.revenue = entry.revenue.plus(toDecimal(row.revenue));
    }

    const classified = classifyProducts([...sales.values()]);
    const calculatedAt = now;
    for (const batch of chunk(classified)) {
      const values = batch.map((c) => Prisma.sql`(${randomUUID()}, ${shopId}, ${c.productId}, ${c.abcClass}, ${c.xyzClass}, ${calculatedAt})`);
      await this.prisma.$executeRaw`
        INSERT INTO InventoryClassification (id, shopId, productId, abcClass, xyzClass, calculatedAt)
        VALUES ${Prisma.join(values)}
        ON DUPLICATE KEY UPDATE abcClass = VALUES(abcClass), xyzClass = VALUES(xyzClass), calculatedAt = VALUES(calculatedAt)
      `;
    }
    // A product that was deleted since its last classification leaves the table.
    await this.prisma.$executeRaw`
      DELETE ic FROM InventoryClassification ic
      INNER JOIN Product p ON p.id = ic.productId
      WHERE ic.shopId = ${shopId} AND (p.isDeleted = true OR p.shopId <> ic.shopId)
    `;

    this.logger.log(`Classified ${classified.length} product(s) of shop ${shopId} over ${CLASSIFICATION_WEEKS} weeks`);
    return { products: classified.length, windowStart: start, windowEnd: end };
  }
}

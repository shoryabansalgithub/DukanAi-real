import { Injectable } from '@nestjs/common';
import { GstRate, InvoiceStatus, InvoiceType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDateString } from '../../common/time/business-day';
import { ExportRange, resolveExportRange } from '../analytics-range';
import { csvRow } from '../csv';
import { completedInvoiceFilter, INVOICE_SIGN, ITEM_TAXABLE, toDecimal, toInt } from '../engines/invoice-sql';
import { ShopTimezoneService } from './shop-timezone.service';

/** Receives one CSV chunk; resolves once the chunk has been accepted (backpressure-aware). */
export type CsvSink = (chunk: string) => Promise<void> | void;

export interface ResolvedExportRange extends ExportRange {
  timeZone: string;
}

export const EXPORT_BATCH_SIZE = 500;

export const INVOICES_CSV_COLUMNS = [
  'invoiceNumber', 'type', 'status', 'businessDate', 'createdAt', 'customerName', 'customerPhone',
  'cashierName', 'paymentMode', 'subtotal', 'discountAmount', 'taxableAmount', 'cgstAmount', 'sgstAmount',
  'igstAmount', 'taxAmount', 'roundOffAmount', 'totalAmount', 'paidAmount', 'changeAmount', 'udharAmount',
] as const;

export const INVOICE_ITEMS_CSV_COLUMNS = [
  'invoiceNumber', 'type', 'businessDate', 'productSku', 'productName', 'quantity', 'unit', 'sellingPrice',
  'discountPercent', 'discountAmount', 'taxableAmount', 'gstRate', 'cgstAmount', 'sgstAmount', 'igstAmount',
  'totalAmount',
] as const;

export const GST_SUMMARY_CSV_COLUMNS = [
  'gstRate', 'invoiceCount', 'taxableAmount', 'cgst', 'sgst', 'igst', 'cess', 'total',
] as const;

const GST_RATE_PERCENT: Record<GstRate, string> = {
  ZERO: '0',
  FIVE: '5',
  TWELVE: '12',
  EIGHTEEN: '18',
  TWENTYEIGHT: '28',
};

export function gstRateLabel(rate: string): string {
  return (GST_RATE_PERCENT as Record<string, string>)[rate] ?? rate;
}

const INVOICE_EXPORT_SELECT = {
  id: true,
  invoiceNumber: true,
  type: true,
  status: true,
  createdAt: true,
  paymentMode: true,
  subtotal: true,
  discountAmount: true,
  taxableAmount: true,
  cgstAmount: true,
  sgstAmount: true,
  igstAmount: true,
  taxAmount: true,
  roundOffAmount: true,
  totalAmount: true,
  paidAmount: true,
  changeAmount: true,
  udharAmount: true,
  customer: { select: { name: true, phone: true } },
  cashier: { select: { name: true } },
} satisfies Prisma.InvoiceSelect;

const INVOICE_ITEMS_EXPORT_SELECT = {
  id: true,
  invoiceNumber: true,
  type: true,
  createdAt: true,
  items: {
    where: { isDeleted: false },
    orderBy: { createdAt: 'asc' },
    select: {
      productSku: true,
      productName: true,
      quantity: true,
      unit: true,
      sellingPrice: true,
      discountPercent: true,
      discountAmount: true,
      taxableAmount: true,
      gstRate: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      totalAmount: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

/**
 * Streaming CSV reports (contract §6). Invoices are paged in batches of
 * `EXPORT_BATCH_SIZE` ordered by (createdAt, id) so memory stays bounded
 * regardless of the range size.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shopTimezone: ShopTimezoneService,
  ) {}

  /** Validates `from`/`to` against the shop's business days; throws 400s (see `resolveExportRange`). */
  async resolveRange(shopId: string, from?: string, to?: string): Promise<ResolvedExportRange> {
    const timeZone = await this.shopTimezone.resolve(shopId);
    return { ...resolveExportRange(from, to, timeZone), timeZone };
  }

  async streamInvoicesCsv(shopId: string, range: ResolvedExportRange, sink: CsvSink): Promise<void> {
    await sink(csvRow(INVOICES_CSV_COLUMNS));
    await this.forEachInvoiceBatch(shopId, range, INVOICE_EXPORT_SELECT, async (batch) => {
      const lines = batch.map((invoice) =>
        csvRow([
          invoice.invoiceNumber,
          invoice.type,
          invoice.status,
          businessDateString(invoice.createdAt, range.timeZone),
          invoice.createdAt,
          invoice.customer?.name ?? '',
          invoice.customer?.phone ?? '',
          invoice.cashier.name,
          invoice.paymentMode,
          invoice.subtotal,
          invoice.discountAmount,
          invoice.taxableAmount,
          invoice.cgstAmount,
          invoice.sgstAmount,
          invoice.igstAmount,
          invoice.taxAmount,
          invoice.roundOffAmount,
          invoice.totalAmount,
          invoice.paidAmount,
          invoice.changeAmount,
          invoice.udharAmount,
        ]),
      );
      await sink(lines.join(''));
    });
  }

  async streamInvoiceItemsCsv(shopId: string, range: ResolvedExportRange, sink: CsvSink): Promise<void> {
    await sink(csvRow(INVOICE_ITEMS_CSV_COLUMNS));
    await this.forEachInvoiceBatch(shopId, range, INVOICE_ITEMS_EXPORT_SELECT, async (batch) => {
      const lines: string[] = [];
      for (const invoice of batch) {
        const businessDate = businessDateString(invoice.createdAt, range.timeZone);
        for (const item of invoice.items) {
          lines.push(
            csvRow([
              invoice.invoiceNumber,
              invoice.type,
              businessDate,
              item.productSku,
              item.productName,
              item.quantity,
              item.unit,
              item.sellingPrice,
              item.discountPercent,
              item.discountAmount,
              item.taxableAmount,
              gstRateLabel(item.gstRate),
              item.cgstAmount,
              item.sgstAmount,
              item.igstAmount,
              item.totalAmount,
            ]),
          );
        }
      }
      if (lines.length) await sink(lines.join(''));
    });
  }

  /** Per-GST-rate totals for COMPLETED invoices in the range; returns are subtracted from sales. */
  async streamGstSummaryCsv(shopId: string, range: ResolvedExportRange, sink: CsvSink): Promise<void> {
    await sink(csvRow(GST_SUMMARY_CSV_COLUMNS));

    const rows = await this.prisma.$queryRaw<
      Array<{ gstRate: string; invoiceCount: unknown; taxable: unknown; cgst: unknown; sgst: unknown; igst: unknown; cess: unknown; total: unknown }>
    >`
      SELECT
        ii.gstRate AS gstRate,
        COUNT(DISTINCT CASE WHEN i.type = ${InvoiceType.SALE} THEN i.id END) AS invoiceCount,
        COALESCE(SUM(${INVOICE_SIGN} * ${ITEM_TAXABLE}), 0) AS taxable,
        COALESCE(SUM(${INVOICE_SIGN} * ii.cgstAmount), 0)   AS cgst,
        COALESCE(SUM(${INVOICE_SIGN} * ii.sgstAmount), 0)   AS sgst,
        COALESCE(SUM(${INVOICE_SIGN} * ii.igstAmount), 0)   AS igst,
        COALESCE(SUM(${INVOICE_SIGN} * ii.cessAmount), 0)   AS cess,
        COALESCE(SUM(${INVOICE_SIGN} * ii.totalAmount), 0)  AS total
      FROM InvoiceItem ii
      INNER JOIN Invoice i ON i.id = ii.invoiceId
      WHERE ${completedInvoiceFilter(shopId, range.start, range.end)}
        AND ii.isDeleted = false
      GROUP BY ii.gstRate
      ORDER BY ii.gstRate ASC
    `;

    const lines = rows.map((row) =>
      csvRow([
        gstRateLabel(row.gstRate),
        toInt(row.invoiceCount),
        toDecimal(row.taxable).toFixed(2),
        toDecimal(row.cgst).toFixed(2),
        toDecimal(row.sgst).toFixed(2),
        toDecimal(row.igst).toFixed(2),
        toDecimal(row.cess).toFixed(2),
        toDecimal(row.total).toFixed(2),
      ]),
    );
    if (lines.length) await sink(lines.join(''));
  }

  /**
   * Cursor-paginates the shop's COMPLETED sale/return invoices in the range,
   * oldest first. The status/type predicate mirrors `completedInvoiceFilter`
   * (the SQL engines' money filter) so a total summed from the CSV matches the
   * dashboards instead of also counting DRAFT and CANCELLED rows.
   */
  private async forEachInvoiceBatch<S extends Prisma.InvoiceSelect & { id: true }>(
    shopId: string,
    range: ExportRange,
    select: S,
    handle: (batch: Array<Prisma.InvoiceGetPayload<{ select: S }>>) => Promise<void>,
  ): Promise<void> {
    let cursorId: string | undefined;
    for (;;) {
      const batch = await this.prisma.invoice.findMany({
        where: {
          shopId,
          isDeleted: false,
          status: InvoiceStatus.COMPLETED,
          type: { in: [InvoiceType.SALE, InvoiceType.SALES_RETURN] },
          createdAt: { gte: range.start, lt: range.end },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: EXPORT_BATCH_SIZE,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        select,
      });
      if (batch.length === 0) break;
      await handle(batch);
      if (batch.length < EXPORT_BATCH_SIZE) break;
      // `S` always selects `id`; Prisma's mapped payload type cannot express that generically.
      cursorId = (batch[batch.length - 1] as unknown as { id: string }).id;
    }
  }
}

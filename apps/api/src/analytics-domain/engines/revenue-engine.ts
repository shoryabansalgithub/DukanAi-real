import { Injectable } from '@nestjs/common';
import { InvoiceStatus, InvoiceType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { completedInvoiceFilter, INVOICE_SIGN, IS_RETURN, IS_SALE, ITEM_PROFIT, toDecimal, toInt } from './invoice-sql';

export interface InvoiceTotals {
  /** Sum of COMPLETED SALE invoice totals. */
  grossSales: Prisma.Decimal;
  /** Sum of COMPLETED SALES_RETURN invoice totals. */
  returns: Prisma.Decimal;
  /** grossSales - returns. */
  netSales: Prisma.Decimal;
  /** Number of COMPLETED SALE invoices. */
  orders: number;
  /** Number of COMPLETED SALES_RETURN invoices. */
  returnCount: number;
}

export interface PaymentModeBucket {
  mode: string;
  amount: Prisma.Decimal;
}

/**
 * Live invoice aggregates. Every figure is computed straight from
 * Invoice / InvoiceItem / InvoicePayment rows with the contract §6 rules, so
 * nothing depends on a background aggregation job having run.
 */
@Injectable()
export class RevenueEngine {
  constructor(private readonly prisma: PrismaService) {}

  /** Sales / returns / order counts for [start, end) (omit both for all time). */
  async totals(shopId: string, start?: Date, end?: Date): Promise<InvoiceTotals> {
    const rows = await this.prisma.$queryRaw<
      Array<{ grossSales: unknown; returns: unknown; orders: unknown; returnCount: unknown }>
    >`
      SELECT
        COALESCE(SUM(${IS_SALE} * i.totalAmount), 0)   AS grossSales,
        COALESCE(SUM(${IS_RETURN} * i.totalAmount), 0) AS returns,
        COALESCE(SUM(${IS_SALE}), 0)                   AS orders,
        COALESCE(SUM(${IS_RETURN}), 0)                 AS returnCount
      FROM Invoice i
      WHERE ${completedInvoiceFilter(shopId, start, end)}
    `;
    const row = rows[0];
    const grossSales = toDecimal(row?.grossSales);
    const returns = toDecimal(row?.returns);
    return {
      grossSales,
      returns,
      netSales: grossSales.minus(returns),
      orders: toInt(row?.orders),
      returnCount: toInt(row?.returnCount),
    };
  }

  /** Gross profit (taxable value - cost of goods) of sale lines minus return lines in [start, end). */
  async profit(shopId: string, start?: Date, end?: Date): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<Array<{ profit: unknown }>>`
      SELECT COALESCE(SUM(${INVOICE_SIGN} * ${ITEM_PROFIT}), 0) AS profit
      FROM InvoiceItem ii
      INNER JOIN Invoice i ON i.id = ii.invoiceId
      WHERE ${completedInvoiceFilter(shopId, start, end)}
        AND ii.isDeleted = false
    `;
    return toDecimal(rows[0]?.profit);
  }

  /**
   * Amount collected per tender for SALE invoices in [start, end): one bucket
   * per `InvoicePayment.tender`, an `UDHAR` bucket from `Invoice.udharAmount`,
   * and, for legacy invoices without payment rows, `paidAmount` bucketed under
   * `Invoice.paymentMode`.
   *
   * With `netOfRefunds`, COMPLETED SALES_RETURN invoices of the same window are
   * subtracted the same way (refund tender rows, credit reversed, legacy
   * `paidAmount`), so the buckets add up to net sales. Buckets that net to
   * zero are dropped; a negative bucket (refunds exceeding that tender's
   * takings in the window) is kept so the totals still reconcile.
   */
  async paymentModeBuckets(
    shopId: string,
    start: Date,
    end: Date,
    options: { netOfRefunds?: boolean } = {},
  ): Promise<PaymentModeBucket[]> {
    const buckets = new Map<string, Prisma.Decimal>();
    const add = (mode: string, amount: Prisma.Decimal | null | undefined, sign: 1 | -1) => {
      if (!amount || amount.isZero()) return;
      buckets.set(mode, (buckets.get(mode) ?? new Prisma.Decimal(0)).plus(sign === 1 ? amount : amount.neg()));
    };

    const types: Array<[InvoiceType, 1 | -1]> = [[InvoiceType.SALE, 1]];
    if (options.netOfRefunds) types.push([InvoiceType.SALES_RETURN, -1]);

    await Promise.all(
      types.map(async ([type, sign]) => {
        const where: Prisma.InvoiceWhereInput = {
          shopId,
          type,
          status: InvoiceStatus.COMPLETED,
          isDeleted: false,
          createdAt: { gte: start, lt: end },
        };
        const [tenders, udhar, legacy] = await Promise.all([
          // InvoicePayment is not tenant-scoped by the Prisma extension: explicit shopId.
          this.prisma.invoicePayment.groupBy({
            by: ['tender'],
            where: { shopId, invoice: where },
            _sum: { amount: true },
          }),
          this.prisma.invoice.aggregate({ where, _sum: { udharAmount: true } }),
          this.prisma.invoice.groupBy({
            by: ['paymentMode'],
            where: { ...where, payments: { none: {} } },
            _sum: { paidAmount: true },
          }),
        ]);
        for (const group of tenders) add(group.tender, group._sum.amount, sign);
        add('UDHAR', udhar._sum.udharAmount, sign);
        for (const group of legacy) add(group.paymentMode, group._sum.paidAmount, sign);
      }),
    );

    return [...buckets.entries()]
      .filter(([, amount]) => !amount.isZero())
      .map(([mode, amount]) => ({ mode, amount }))
      .sort((a, b) => b.amount.comparedTo(a.amount));
  }
}

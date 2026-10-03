import { InvoiceStatus, InvoiceType, Prisma } from '@prisma/client';

/**
 * Shared raw-SQL fragments implementing the contract §6 rules:
 * - sales are `type = SALE`, returns are `type = SALES_RETURN`,
 * - only `status = COMPLETED` rows count (CANCELLED / DRAFT are excluded),
 * - returns are subtracted from sales.
 *
 * Table aliases are fixed: `i` = Invoice, `ii` = InvoiceItem.
 */

/** +1 for a SALE invoice, -1 for a SALES_RETURN (alias `i`). */
export const INVOICE_SIGN = Prisma.sql`(CASE WHEN i.type = ${InvoiceType.SALE} THEN 1 ELSE -1 END)`;

/** 1 for a SALE invoice, 0 otherwise (alias `i`). */
export const IS_SALE = Prisma.sql`(CASE WHEN i.type = ${InvoiceType.SALE} THEN 1 ELSE 0 END)`;

/** 1 for a SALES_RETURN invoice, 0 otherwise (alias `i`). */
export const IS_RETURN = Prisma.sql`(CASE WHEN i.type = ${InvoiceType.SALES_RETURN} THEN 1 ELSE 0 END)`;

/**
 * Taxable amount of a line (alias `ii`). Legacy rows written before the
 * `taxableAmount` column existed carry 0 there but a positive `totalAmount`;
 * for those the pre-tax value is reconstructed from price, quantity and the
 * percentage discount.
 */
export const ITEM_TAXABLE = Prisma.sql`COALESCE(NULLIF(ii.taxableAmount, 0), CASE WHEN ii.totalAmount > 0 THEN ii.sellingPrice * ii.quantity * (1 - ii.discountPercent / 100) ELSE 0 END)`;

/** Gross profit of a line: taxable value minus cost of goods (alias `ii`). */
export const ITEM_PROFIT = Prisma.sql`(${ITEM_TAXABLE} - ii.costPrice * ii.quantity)`;

/**
 * WHERE fragment selecting the shop's COMPLETED sale/return invoices (alias `i`)
 * created in [start, end). Both bounds are optional (all time).
 */
export function completedInvoiceFilter(shopId: string, start?: Date, end?: Date): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`i.shopId = ${shopId}`,
    Prisma.sql`i.status = ${InvoiceStatus.COMPLETED}`,
    Prisma.sql`i.isDeleted = false`,
    Prisma.sql`i.type IN (${InvoiceType.SALE}, ${InvoiceType.SALES_RETURN})`,
  ];
  if (start) parts.push(Prisma.sql`i.createdAt >= ${start}`);
  if (end) parts.push(Prisma.sql`i.createdAt < ${end}`);
  return Prisma.join(parts, ' AND ');
}

/** Converts a raw MySQL aggregate value (Decimal, bigint, number, string or null) into a Decimal. */
export function toDecimal(value: unknown): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  if (Prisma.Decimal.isDecimal(value)) return value as Prisma.Decimal;
  if (typeof value === 'bigint') return new Prisma.Decimal(value.toString());
  if (typeof value === 'number' || typeof value === 'string') return new Prisma.Decimal(value);
  return new Prisma.Decimal(0);
}

/** Converts a raw MySQL count/sum into a JS integer. */
export function toInt(value: unknown): number {
  return toDecimal(value).toDecimalPlaces(0).toNumber();
}

/** Money for JSON responses: 2 dp number. */
export function toMoney(value: Prisma.Decimal): number {
  return value.toDecimalPlaces(2).toNumber();
}

/** Percentage share `part / whole * 100` as an integer, 0 when the whole is not positive. */
export function percentShare(part: Prisma.Decimal, whole: Prisma.Decimal): number {
  if (whole.lessThanOrEqualTo(0)) return 0;
  return part.div(whole).mul(100).toDecimalPlaces(0).toNumber();
}

/** `(current - previous) / previous * 100` with 1 dp, or null when there is no baseline. */
export function pctChange(current: Prisma.Decimal, previous: Prisma.Decimal): number | null {
  if (previous.lessThanOrEqualTo(0)) return null;
  return current.minus(previous).div(previous).mul(100).toDecimalPlaces(1).toNumber();
}

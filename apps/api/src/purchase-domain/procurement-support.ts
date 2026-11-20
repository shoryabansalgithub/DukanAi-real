import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { financialYearLabel, safeTimeZone } from '../common/time/business-day';
import type { OrderedLine } from './services/purchase-receipt.service';

type Db = Prisma.TransactionClient;

/** The shop's business time zone (`ShopSettings.timezone`, default Asia/Kolkata). */
export async function shopTimeZone(db: Db, shopId: string): Promise<string> {
  const settings = await db.shopSettings.findUnique({ where: { shopId }, select: { timezone: true } });
  return safeTimeZone(settings?.timezone);
}

/** Financial-year label (`2026-27`) of `now` in the shop's time zone, for GRN / PR / VB / SCN numbers. */
export async function shopFinancialYear(db: Db, shopId: string, now: Date): Promise<string> {
  return financialYearLabel(now, await shopTimeZone(db, shopId));
}

/** Procurement header tables that may be row-locked by id (the name is never taken from a request). */
const LOCKABLE = {
  PurchaseOrder: Prisma.raw('PurchaseOrder'),
  GoodsReceipt: Prisma.raw('GoodsReceipt'),
  VendorBill: Prisma.raw('VendorBill'),
  PurchaseReturn: Prisma.raw('PurchaseReturn'),
  SupplierCreditNote: Prisma.raw('SupplierCreditNote'),
} as const;
export type LockableDocument = keyof typeof LOCKABLE;

/**
 * Locks one live document row of the shop (`SELECT ... FOR UPDATE`) and
 * returns its status: every state change of a document reads the state it
 * changes under this lock, so two concurrent actors are serialised and the
 * second sees the first's outcome (release audit S5/S14). 404 when the row
 * is not the shop's.
 */
export async function lockDocument(db: Db, table: LockableDocument, id: string, shopId: string, code: string): Promise<{ id: string; status: string }> {
  const rows = await db.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status FROM ${LOCKABLE[table]} WHERE id = ${id} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundException({ message: `${table} ${id} not found`, code });
  return rows[0];
}

/** The order line's cost per unit after its discount, before GST (2 dp, the receipt line's precision). */
export function netUnitCost(orderLine: Pick<OrderedLine, 'quantity' | 'unitCost' | 'price' | 'discount'>): Prisma.Decimal {
  const quantity = orderLine.quantity;
  if (quantity.lessThanOrEqualTo(0)) return orderLine.unitCost;
  // `price` is the line's taxable value (quantity × unitCost − discount, GST taken out in INCLUSIVE mode).
  if (orderLine.price.greaterThan(0)) return orderLine.price.dividedBy(quantity).toDecimalPlaces(2);
  const gross = quantity.times(orderLine.unitCost).minus(orderLine.discount ?? 0);
  return Prisma.Decimal.max(gross, 0).dividedBy(quantity).toDecimalPlaces(2);
}

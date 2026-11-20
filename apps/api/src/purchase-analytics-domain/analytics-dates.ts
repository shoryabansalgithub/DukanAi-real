import { Prisma } from '@prisma/client';
import { safeTimeZone, toZonedParts, zonedDateToUtc } from '../common/time/business-day';

type Db = Pick<Prisma.TransactionClient, 'shopSettings'>;

/**
 * Dates of the purchase analytics, in the shop's business time zone
 * (`ShopSettings.timezone`) rather than the server's (release audit #26: a
 * server in UTC filed an Indian shop's purchases after 18:30 under the
 * previous day, and month boundaries moved by 5.5 hours).
 *
 * Snapshot rows are keyed by a calendar date stored as UTC midnight of that
 * date (`dateKey`, `monthKey`); the window a figure covers starts at the
 * real instant the shop's month began (`monthStart`).
 */
export interface PurchaseBusinessDates {
  timeZone: string;
  dateKey: Date;
  monthKey: Date;
  monthStart: Date;
}

export async function purchaseBusinessDates(db: Db, shopId: string, now: Date): Promise<PurchaseBusinessDates> {
  const settings = await db.shopSettings.findUnique({ where: { shopId }, select: { timezone: true } });
  const timeZone = safeTimeZone(settings?.timezone);
  const p = toZonedParts(now, timeZone);
  return {
    timeZone,
    dateKey: new Date(Date.UTC(p.year, p.month - 1, p.day)),
    monthKey: new Date(Date.UTC(p.year, p.month - 1, 1)),
    monthStart: zonedDateToUtc(p.year, p.month, 1, timeZone),
  };
}

/** `YYYY-MM-DD` as the snapshot key of that calendar date, or null when it is not a valid date. */
export function dateKeyOf(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const key = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return key.getUTCMonth() === Number(m[2]) - 1 && key.getUTCDate() === Number(m[3]) ? key : null;
}

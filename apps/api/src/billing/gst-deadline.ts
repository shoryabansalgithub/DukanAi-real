import { toZonedParts } from '../common/time/business-day';

/**
 * Dates a return is judged by, in the shop's time zone (the business day the
 * documents carry, roadmap 9.6).
 */

/**
 * CGST Act s.34(2): a credit note for a supply may be issued no later than
 * 30 November following the end of the financial year of that supply (the
 * year of its invoice). `YYYY-MM-DD` of that last day.
 */
export function gstCreditNoteDeadline(saleAt: Date, timeZone: string): string {
  const sale = toZonedParts(saleAt, timeZone);
  const financialYearStart = sale.month >= 4 ? sale.year : sale.year - 1;
  return `${financialYearStart + 1}-11-30`;
}

/** True once the business day of `now` is after the credit-note deadline of a sale made at `saleAt`. */
export function isPastGstCreditNoteDeadline(saleAt: Date, now: Date, timeZone: string): boolean {
  const today = toZonedParts(now, timeZone);
  const todayString = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  return todayString > gstCreditNoteDeadline(saleAt, timeZone);
}

/** Whole business days from the day of `from` to the day of `to` (0 on the same day). */
export function businessDaysBetween(from: Date, to: Date, timeZone: string): number {
  const a = toZonedParts(from, timeZone);
  const b = toZonedParts(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

import { BadRequestException } from '@nestjs/common';
import {
  businessDateString,
  endOfBusinessDay,
  parseBusinessDate,
  startOfBusinessDay,
  timeZoneOffsetMs,
  toZonedParts,
  zonedDateToUtc,
} from '../common/time/business-day';

/**
 * Pure business-day range helpers for the dashboard / reports. Everything is
 * expressed as UTC instants [start, end) that line up with whole business days
 * in the shop timezone, so SQL can filter with `createdAt >= start AND
 * createdAt < end`.
 */

export type AnalyticsRange = 'today' | 'week' | 'month' | 'year';

export const RANGE_DAYS: Record<AnalyticsRange, number> = {
  today: 1,
  week: 7,
  month: 30,
  year: 365,
};

export const MAX_EXPORT_RANGE_DAYS = 366;
export const MAX_TREND_DAYS = 365;

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return typeof value === 'string' && value in RANGE_DAYS;
}

export function rangeDays(range: unknown, fallback: AnalyticsRange = 'week'): number {
  return isAnalyticsRange(range) ? RANGE_DAYS[range] : RANGE_DAYS[fallback];
}

/** Local midnight `days` business days after (negative: before) the business day containing `dayStart`. */
export function shiftBusinessDays(dayStart: Date, days: number, timeZone: string): Date {
  const p = toZonedParts(dayStart, timeZone);
  // Date.UTC normalises day overflow/underflow, giving correct calendar arithmetic.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedDateToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

export interface BusinessDayWindow {
  /** Inclusive start (local midnight of the first business day). */
  start: Date;
  /** Exclusive end (local midnight after the last business day). */
  end: Date;
  /** Start of the immediately preceding window of the same length. */
  prevStart: Date;
  days: number;
  fromDate: string;
  toDate: string;
}

/** The last `days` whole business days ending with the business day containing `now`. */
export function trailingBusinessDays(days: number, timeZone: string, now: Date = new Date()): BusinessDayWindow {
  const safeDays = Math.max(1, Math.floor(days));
  const todayStart = startOfBusinessDay(now, timeZone);
  const end = endOfBusinessDay(now, timeZone);
  const start = shiftBusinessDays(todayStart, -(safeDays - 1), timeZone);
  const prevStart = shiftBusinessDays(start, -safeDays, timeZone);
  return {
    start,
    end,
    prevStart,
    days: safeDays,
    fromDate: businessDateString(start, timeZone),
    toDate: businessDateString(todayStart, timeZone),
  };
}

/** `YYYY-MM-DD` keys of every business day in [start, end). */
export function enumerateBusinessDays(start: Date, end: Date, timeZone: string, hardLimit = 5000): string[] {
  const keys: string[] = [];
  if (start.getTime() >= end.getTime()) return keys;
  let cursor = startOfBusinessDay(start, timeZone);
  while (cursor.getTime() < end.getTime() && keys.length < hardLimit) {
    keys.push(businessDateString(cursor, timeZone));
    cursor = shiftBusinessDays(cursor, 1, timeZone);
  }
  return keys;
}

export function countBusinessDays(start: Date, end: Date, timeZone: string): number {
  return enumerateBusinessDays(start, end, timeZone).length;
}

/** Formats a UTC offset in ms as MySQL expects it for CONVERT_TZ, e.g. `+05:30`. */
export function formatUtcOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const mm = String(totalMinutes % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

export function mysqlOffsetAt(instant: Date, timeZone: string): string {
  return formatUtcOffset(timeZoneOffsetMs(instant, timeZone));
}

/** True when the timezone offset is the same at both ends of [start, end) (no DST switch inside). */
export function hasUniformOffset(start: Date, end: Date, timeZone: string): boolean {
  const last = new Date(Math.max(start.getTime(), end.getTime() - 1000));
  return timeZoneOffsetMs(start, timeZone) === timeZoneOffsetMs(last, timeZone);
}

/** UTC midnight of a `YYYY-MM-DD` business date; the value to store in a `@db.Date` column. */
export function utcMidnightOfBusinessDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

const labelFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Chart label (`18 Sept`) for a `YYYY-MM-DD` key, independent of the server timezone. */
export function businessDayLabel(key: string): string {
  return labelFormatter.format(utcMidnightOfBusinessDate(key));
}

export interface ExportRange {
  start: Date;
  end: Date;
  fromDate: string;
  toDate: string;
  days: number;
}

/**
 * Validates `from` / `to` (`YYYY-MM-DD`, business-day inclusive) for the CSV
 * exports. Defaults to today; rejects malformed dates, inverted ranges and
 * ranges longer than `MAX_EXPORT_RANGE_DAYS` with 400s.
 */
export function resolveExportRange(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
  now: Date = new Date(),
): ExportRange {
  const today = businessDateString(now, timeZone);
  const toDate = to?.trim() || today;
  const fromDate = from?.trim() || toDate;

  const start = parseBusinessDate(fromDate, timeZone);
  const toStart = parseBusinessDate(toDate, timeZone);
  if (!start || !toStart) {
    throw new BadRequestException({
      message: 'Dates must be in YYYY-MM-DD format',
      code: 'INVALID_DATE',
      details: { from: fromDate, to: toDate },
    });
  }
  if (start.getTime() > toStart.getTime()) {
    throw new BadRequestException({
      message: '`from` must not be after `to`',
      code: 'INVALID_DATE_RANGE',
      details: { from: fromDate, to: toDate },
    });
  }
  const end = endOfBusinessDay(toStart, timeZone);
  const days = countBusinessDays(start, end, timeZone);
  if (days > MAX_EXPORT_RANGE_DAYS) {
    throw new BadRequestException({
      message: `Export range must not exceed ${MAX_EXPORT_RANGE_DAYS} days`,
      code: 'DATE_RANGE_TOO_LARGE',
      details: { from: fromDate, to: toDate, days, maxDays: MAX_EXPORT_RANGE_DAYS },
    });
  }
  return { start, end, fromDate, toDate, days };
}

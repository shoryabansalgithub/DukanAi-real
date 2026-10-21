/**
 * Business-day helpers.
 *
 * Every "today", "financial year" and "invoice date" decision in the POS
 * subsystem goes through these functions so that billing, dashboards, reports
 * and shifts all agree on what day it is. Dates are computed in the shop's
 * IANA timezone (ShopSettings.timezone, default Asia/Kolkata) using Intl only,
 * so no extra dependency is required.
 */
import { BadRequestException } from '@nestjs/common';

export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

export interface BusinessDayParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const partCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partCache.set(timeZone, fmt);
  }
  return fmt;
}

export function safeTimeZone(timeZone?: string | null): string {
  if (!timeZone) return DEFAULT_BUSINESS_TIMEZONE;
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

/** Wall-clock parts of `instant` in the given timezone. */
export function toZonedParts(instant: Date, timeZone: string): BusinessDayParts {
  const parts = formatter(safeTimeZone(timeZone)).formatToParts(instant);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') === 24 ? 0 : pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Offset (ms) of the timezone relative to UTC at the given instant. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** `YYYY-MM-DD` of the business day containing `instant`. */
export function businessDateString(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Compact `YYYYMMDD` form used inside document numbers. */
export function businessDateCompact(instant: Date, timeZone: string): string {
  return businessDateString(instant, timeZone).replace(/-/g, '');
}

/**
 * UTC instant for local midnight (00:00:00.000) of the business day that
 * contains `instant`, in the given timezone. Handles DST by re-evaluating the
 * offset at the candidate midnight.
 */
export function startOfBusinessDay(instant: Date, timeZone: string): Date {
  const p = toZonedParts(instant, timeZone);
  return zonedDateToUtc(p.year, p.month, p.day, timeZone);
}

/** UTC instant for the start of the next business day (exclusive upper bound). */
export function endOfBusinessDay(instant: Date, timeZone: string): Date {
  const start = startOfBusinessDay(instant, timeZone);
  // Add one local day: compute midnight of (day + 1) using the same routine.
  const p = toZonedParts(new Date(start.getTime() + 36 * 3600 * 1000), timeZone);
  return zonedDateToUtc(p.year, p.month, p.day, timeZone);
}

/** Convert a local calendar date (midnight) in `timeZone` to a UTC instant. */
export function zonedDateToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset1 = timeZoneOffsetMs(new Date(guess), timeZone);
  const candidate = guess - offset1;
  // Re-check the offset at the candidate instant (DST transitions).
  const offset2 = timeZoneOffsetMs(new Date(candidate), timeZone);
  return new Date(guess - offset2);
}

/**
 * True when `value` is `YYYY-MM-DD` naming a day the calendar has:
 * `2026-02-30`, `2026-04-31` and `2025-02-29` are refused (a `Date` would
 * silently roll them over into the next month).
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/** Parse `YYYY-MM-DD` into the UTC instant of local midnight in `timeZone`; null unless it is a real calendar day. */
export function parseBusinessDate(value: string, timeZone: string): Date | null {
  if (!isCalendarDate(value)) return null;
  const [y, mo, d] = value.trim().split('-').map(Number);
  return zonedDateToUtc(y, mo, d, timeZone);
}

/**
 * Inclusive business-day range [from, to] expressed as UTC instants
 * [start, endExclusive). Missing `from` defaults to `to`; missing `to`
 * defaults to today. A given bound that is not a calendar day is
 * `400 INVALID_DATE` (it used to fall back to today silently).
 */
export function businessDayRange(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
  now: Date = new Date(),
): { start: Date; end: Date; fromDate: string; toDate: string } {
  if ((to && !isCalendarDate(to)) || (from && !isCalendarDate(from))) {
    throw new BadRequestException({ message: 'Dates must be calendar days in YYYY-MM-DD format.', code: 'INVALID_DATE', details: { from, to } });
  }
  const toDate = to ? to.trim() : businessDateString(now, timeZone);
  const fromDate = from ? from.trim() : toDate;
  const start = parseBusinessDate(fromDate, timeZone)!;
  const toStart = parseBusinessDate(toDate, timeZone)!;
  const end = endOfBusinessDay(toStart, timeZone);
  return { start, end, fromDate, toDate };
}

/** Indian financial year label, e.g. `2026-27` for dates from Apr 2026 to Mar 2027. */
export function financialYearLabel(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  const startYear = p.month >= 4 ? p.year : p.year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** True when both instants fall on the same business day. */
export function isSameBusinessDay(a: Date, b: Date, timeZone: string): boolean {
  return businessDateString(a, timeZone) === businessDateString(b, timeZone);
}

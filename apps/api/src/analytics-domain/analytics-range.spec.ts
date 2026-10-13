import { BadRequestException } from '@nestjs/common';
import {
  businessDayLabel,
  countBusinessDays,
  enumerateBusinessDays,
  formatUtcOffset,
  hasUniformOffset,
  mysqlOffsetAt,
  rangeDays,
  resolveExportRange,
  shiftBusinessDays,
  trailingBusinessDays,
  utcMidnightOfBusinessDate,
} from './analytics-range';

const IST = 'Asia/Kolkata';
// 2026-09-18 20:30 UTC is already 2026-09-19 02:00 in IST.
const NOW = new Date('2026-09-18T20:30:00.000Z');

describe('trailingBusinessDays', () => {
  it('uses the shop business day, not the UTC date, for "today"', () => {
    const w = trailingBusinessDays(1, IST, NOW);
    expect(w.fromDate).toBe('2026-09-19');
    expect(w.toDate).toBe('2026-09-19');
    expect(w.start.toISOString()).toBe('2026-09-18T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-19T18:30:00.000Z');
    expect(w.prevStart.toISOString()).toBe('2026-09-17T18:30:00.000Z');
  });

  it('spans exactly N whole business days ending today', () => {
    const w = trailingBusinessDays(7, IST, NOW);
    expect(w.fromDate).toBe('2026-09-13');
    expect(w.toDate).toBe('2026-09-19');
    expect(w.start.toISOString()).toBe('2026-09-12T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-19T18:30:00.000Z');
    expect(w.prevStart.toISOString()).toBe('2026-09-05T18:30:00.000Z');
    expect(countBusinessDays(w.start, w.end, IST)).toBe(7);
    expect(countBusinessDays(w.prevStart, w.start, IST)).toBe(7);
  });

  it('crosses month and year boundaries correctly', () => {
    const w = trailingBusinessDays(30, IST, new Date('2026-01-05T10:00:00.000Z'));
    expect(w.fromDate).toBe('2025-12-07');
    expect(w.toDate).toBe('2026-01-05');
    expect(enumerateBusinessDays(w.start, w.end, IST)).toHaveLength(30);
  });

  it('treats non-positive day counts as a single day', () => {
    expect(trailingBusinessDays(0, IST, NOW).days).toBe(1);
  });
});

describe('enumerateBusinessDays', () => {
  it('lists every business day key in [start, end)', () => {
    const w = trailingBusinessDays(3, IST, NOW);
    expect(enumerateBusinessDays(w.start, w.end, IST)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19']);
  });

  it('is empty for an empty range', () => {
    expect(enumerateBusinessDays(NOW, NOW, IST)).toEqual([]);
  });

  it('handles a DST transition without skipping or duplicating a day', () => {
    // US DST starts 2026-03-08 02:00 local.
    const tz = 'America/New_York';
    const start = shiftBusinessDays(new Date('2026-03-07T12:00:00.000Z'), 0, tz);
    const end = shiftBusinessDays(start, 3, tz);
    expect(enumerateBusinessDays(start, end, tz)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(hasUniformOffset(start, end, tz)).toBe(false);
  });
});

describe('offsets', () => {
  it('formats MySQL CONVERT_TZ offsets', () => {
    expect(formatUtcOffset(5.5 * 3600 * 1000)).toBe('+05:30');
    expect(formatUtcOffset(0)).toBe('+00:00');
    expect(formatUtcOffset(-4.5 * 3600 * 1000)).toBe('-04:30');
    expect(mysqlOffsetAt(NOW, IST)).toBe('+05:30');
    expect(mysqlOffsetAt(NOW, 'UTC')).toBe('+00:00');
  });

  it('reports a uniform offset for fixed-offset zones', () => {
    const w = trailingBusinessDays(365, IST, NOW);
    expect(hasUniformOffset(w.start, w.end, IST)).toBe(true);
  });
});

describe('date keys', () => {
  it('maps a business date to a UTC-midnight instant for @db.Date columns', () => {
    expect(utcMidnightOfBusinessDate('2026-09-19').toISOString()).toBe('2026-09-19T00:00:00.000Z');
  });

  it('labels a key independently of the server timezone', () => {
    expect(businessDayLabel('2026-09-19')).toMatch(/^19 Sep/);
  });

  it('maps ranges to day counts with a safe fallback', () => {
    expect(rangeDays('today')).toBe(1);
    expect(rangeDays('week')).toBe(7);
    expect(rangeDays('month')).toBe(30);
    expect(rangeDays('year')).toBe(365);
    expect(rangeDays('bogus')).toBe(7);
    expect(rangeDays(undefined)).toBe(7);
  });
});

describe('resolveExportRange', () => {
  it('defaults to the current business day', () => {
    const r = resolveExportRange(undefined, undefined, IST, NOW);
    expect(r).toMatchObject({ fromDate: '2026-09-19', toDate: '2026-09-19', days: 1 });
    expect(r.start.toISOString()).toBe('2026-09-18T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-09-19T18:30:00.000Z');
  });

  it('defaults `from` to `to` when only `to` is given', () => {
    const r = resolveExportRange(undefined, '2026-08-01', IST, NOW);
    expect(r).toMatchObject({ fromDate: '2026-08-01', toDate: '2026-08-01', days: 1 });
  });

  it('returns an inclusive whole-day range', () => {
    const r = resolveExportRange('2026-04-01', '2026-04-30', IST, NOW);
    expect(r.days).toBe(30);
    expect(r.start.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-04-30T18:30:00.000Z');
  });

  it('rejects malformed dates, inverted ranges and ranges over 366 days', () => {
    expect(() => resolveExportRange('2026/04/01', undefined, IST, NOW)).toThrow(BadRequestException);
    expect(() => resolveExportRange('2026-04-30', '2026-04-01', IST, NOW)).toThrow(BadRequestException);
    expect(() => resolveExportRange('2025-01-01', '2026-01-02', IST, NOW)).toThrow(BadRequestException);
    // Exactly 366 days is still allowed.
    expect(resolveExportRange('2025-01-01', '2026-01-01', IST, NOW).days).toBe(366);
  });

  it('exposes stable machine codes', () => {
    try {
      resolveExportRange('2025-01-01', '2026-06-01', IST, NOW);
      fail('expected a BadRequestException');
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as { code: string };
      expect(body.code).toBe('DATE_RANGE_TOO_LARGE');
    }
  });
});

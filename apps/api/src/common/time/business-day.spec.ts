import { BadRequestException } from '@nestjs/common';
import { businessDayRange, isCalendarDate, parseBusinessDate } from './business-day';

describe('business dates are calendar days (release audit: parseBusinessDate)', () => {
  const TZ = 'Asia/Kolkata';

  it('refuses days the calendar does not have instead of rolling them into the next month', () => {
    for (const impossible of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-06-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-05', 'yesterday', '']) {
      expect({ value: impossible, valid: isCalendarDate(impossible), parsed: parseBusinessDate(impossible, TZ) }).toEqual({ value: impossible, valid: false, parsed: null });
    }
  });

  it('accepts real days, leap days included, as local midnight of the zone', () => {
    expect(parseBusinessDate('2028-02-29', TZ)?.toISOString()).toBe('2028-02-28T18:30:00.000Z');
    expect(parseBusinessDate('2026-12-31', TZ)?.toISOString()).toBe('2026-12-30T18:30:00.000Z');
    expect(parseBusinessDate('2026-02-28', 'UTC')?.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
  });

  it('a range bound that is not a calendar day is 400 INVALID_DATE, not today', () => {
    const now = new Date('2026-10-11T06:00:00Z');
    expect(businessDayRange('2026-10-01', '2026-10-10', TZ, now)).toMatchObject({ fromDate: '2026-10-01', toDate: '2026-10-10' });
    expect(businessDayRange(undefined, undefined, TZ, now)).toMatchObject({ fromDate: '2026-10-11', toDate: '2026-10-11' });
    for (const [from, to] of [['2026-02-30', undefined], [undefined, '2026-02-31'], ['2026-02-01', '2026-04-31']]) {
      let error: unknown;
      try {
        businessDayRange(from, to, TZ, now);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_DATE' });
    }
  });
});

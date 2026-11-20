import { businessDaysBetween, gstCreditNoteDeadline, isPastGstCreditNoteDeadline } from './gst-deadline';

const TZ = 'Asia/Kolkata';

describe('GST credit-note deadline, CGST s.34(2) (audit B8)', () => {
  it('is 30 November after the end of the financial year of the sale, in the shop time zone', () => {
    expect(gstCreditNoteDeadline(new Date('2025-03-31T18:00:00+05:30'), TZ)).toBe('2025-11-30');
    expect(gstCreditNoteDeadline(new Date('2025-04-01T00:10:00+05:30'), TZ)).toBe('2026-11-30');
    // 18:00 UTC on 31 March is 23:30 there (FY 2024-25); 18:31 UTC is already 1 April (FY 2025-26).
    expect(gstCreditNoteDeadline(new Date('2025-03-31T18:00:00Z'), TZ)).toBe('2025-11-30');
    expect(gstCreditNoteDeadline(new Date('2025-03-31T18:31:00Z'), TZ)).toBe('2026-11-30');
  });

  it('allows the whole of 30 November and refuses from 1 December', () => {
    const sale = new Date('2025-01-15T10:00:00+05:30');
    expect(isPastGstCreditNoteDeadline(sale, new Date('2025-11-30T23:59:00+05:30'), TZ)).toBe(false);
    expect(isPastGstCreditNoteDeadline(sale, new Date('2025-12-01T00:00:00+05:30'), TZ)).toBe(true);
  });

  it('counts business days, not 24-hour periods', () => {
    expect(businessDaysBetween(new Date('2026-10-01T23:50:00+05:30'), new Date('2026-10-02T00:05:00+05:30'), TZ)).toBe(1);
    expect(businessDaysBetween(new Date('2026-10-01T00:05:00+05:30'), new Date('2026-10-01T23:50:00+05:30'), TZ)).toBe(0);
    expect(businessDaysBetween(new Date('2026-09-24T12:00:00+05:30'), new Date('2026-10-01T12:00:00+05:30'), TZ)).toBe(7);
  });
});

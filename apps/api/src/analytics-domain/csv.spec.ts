import { Prisma } from '@prisma/client';
import { csvRow, escapeCsvField } from './csv';

describe('escapeCsvField', () => {
  it('passes plain values through unquoted', () => {
    expect(escapeCsvField('INV-2026-27-000001')).toBe('INV-2026-27-000001');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(true)).toBe('true');
    expect(escapeCsvField(10n)).toBe('10');
  });

  it('renders null and undefined as empty cells', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes fields containing commas, quotes or line breaks and doubles inner quotes', () => {
    expect(escapeCsvField('Sharma, Ravi')).toBe('"Sharma, Ravi"');
    expect(escapeCsvField('12" pipe')).toBe('"12"" pipe"');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('a\r\nb')).toBe('"a\r\nb"');
    expect(escapeCsvField('"quoted"')).toBe('"""quoted"""');
  });

  it('keeps Decimal money values exact', () => {
    expect(escapeCsvField(new Prisma.Decimal('1234.50'))).toBe('1234.5');
    expect(escapeCsvField(new Prisma.Decimal('-0.10'))).toBe('-0.1');
  });

  it('serialises dates as ISO-8601', () => {
    expect(escapeCsvField(new Date('2026-09-18T10:15:00.000Z'))).toBe('2026-09-18T10:15:00.000Z');
  });

  it('neutralises spreadsheet formula prefixes in free-text strings', () => {
    expect(escapeCsvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeCsvField('+91 98765')).toBe("'+91 98765");
    expect(escapeCsvField('@handle')).toBe("'@handle");
    // Negative amounts are numbers/Decimals, never strings, so they are untouched.
    expect(escapeCsvField(-5)).toBe('-5');
  });
});

describe('csvRow', () => {
  it('joins escaped fields with commas and terminates with CRLF', () => {
    expect(csvRow(['a', 'b,c', null, 3])).toBe('a,"b,c",,3\r\n');
  });

  it('writes a header row verbatim', () => {
    expect(csvRow(['invoiceNumber', 'type', 'status'])).toBe('invoiceNumber,type,status\r\n');
  });
});

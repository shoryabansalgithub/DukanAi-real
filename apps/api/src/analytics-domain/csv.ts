/**
 * Minimal RFC 4180 CSV writer helpers for the streaming report exports.
 * Pure functions: no Nest, no Prisma.
 */

export const CSV_LINE_BREAK = '\r\n';

/** Leading characters spreadsheet apps interpret as formulas. */
const FORMULA_PREFIX = /^[=+@\t\r]/;

interface DecimalLike {
  toFixed(dp?: number): string;
}

function isDecimalLike(value: unknown): value is DecimalLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function' &&
    typeof (value as { toString?: unknown }).toString === 'function'
  );
}

/**
 * Serialises a single value for a CSV cell: `null`/`undefined` become empty,
 * dates become ISO strings, Decimals keep their exact string form. Fields
 * containing a comma, quote, CR or LF are quoted and inner quotes doubled.
 * Strings that would be read as formulas are prefixed with a quote.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'string') {
    text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  } else if (typeof value === 'bigint') {
    text = value.toString();
  } else if (isDecimalLike(value)) {
    text = value.toString();
  } else {
    text = String(value);
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** One CSV line (terminated with CRLF). */
export function csvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvField).join(',') + CSV_LINE_BREAK;
}

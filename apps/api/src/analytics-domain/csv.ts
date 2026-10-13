/**
 * Minimal RFC 4180 CSV writer helpers for the streaming report exports.
 * Pure functions: no Nest, no Prisma.
 */
import { csvCell } from '../import-export/import-columns';

export const CSV_LINE_BREAK = '\r\n';

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
 * Strings go through the import report's `csvCell` rule: one a spreadsheet
 * would run as a formula (a leading `=`, `+`, `-`, `@`, tab or CR) is
 * prefixed with an apostrophe, a plain number such as `-5.00` is not (the
 * guard here used to miss the leading `-`).
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'string') {
    return csvCell(value);
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

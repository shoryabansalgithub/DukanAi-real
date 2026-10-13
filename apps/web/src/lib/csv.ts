/**
 * One CSV cell, guarded like the API's `csvCell`
 * (`apps/api/src/import-export/import-columns.ts`, audit W14): a text cell a
 * spreadsheet would run as a formula (`=`, `+`, `-`, `@`, a tab or a carriage
 * return at the start) is prefixed with an apostrophe; a plain number such as
 * -500 is not. A cell holding a comma, a quote or a line break is quoted.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

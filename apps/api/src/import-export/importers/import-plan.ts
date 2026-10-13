import { HttpException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ParsedFile, RowIssue, ValidatedRow } from '../import-rows';

/**
 * What an onboarding import does with one row (roadmap 9.20). Every importer
 * plans the whole file against the shop's data before anything is written:
 * a dry run stops there and reports the plan, a real run then applies the
 * CREATE and UPDATE rows one by one through the same services the screens
 * use.
 */
export type RowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP';

export interface PlannedRow {
  rowNumber: number;
  raw: Record<string, string>;
  issues: RowIssue[];
  /** Absent when the row has an error: nothing is written for it. */
  action?: RowAction;
  /** What the row changes, in words ("sellingPrice 599.00 → 649.00", "opening udhar 1250.00"). */
  changes: string[];
  /** Writes the row (CREATE and UPDATE only). Resolves to what was done: a re-check inside the write can find it already done. */
  apply?: () => Promise<RowAction>;
}

/** Who an import acts as: the user who started it, in their shop. */
export interface ImportActor {
  shopId: string;
  userId: string;
  role: Role;
  /** The import job, named in notes and audit rows. */
  jobId: string;
}

export interface Importer {
  plan(rows: ParsedFile['rows'], actor: ImportActor): Promise<PlannedRow[]>;
}

/** A validated row with one more error: it is not written. */
export function refuse(row: ValidatedRow<unknown>, message: string, field?: string): PlannedRow {
  return { rowNumber: row.rowNumber, raw: row.raw, issues: [...row.issues, { field, message, severity: 'error' }], changes: [] };
}

/** The row as the validator left it: refused when it has an error. */
export function invalid(row: ValidatedRow<unknown>): PlannedRow {
  return { rowNumber: row.rowNumber, raw: row.raw, issues: row.issues, changes: [] };
}

/** Case and spacing do not make two keys different (MySQL's collation agrees for SKUs, names and phones). */
export function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Marks every later row whose key repeats an earlier one: a file names each
 * product or customer once, so the second row would silently overwrite the
 * first. Returns the rows to keep planning.
 */
export function refuseRepeats<T>(
  rows: Array<ValidatedRow<T>>,
  keyOf: (value: T) => string | undefined,
  describe: string,
  field: string,
): { kept: Array<ValidatedRow<T>>; repeats: PlannedRow[] } {
  const first = new Map<string, number>();
  const kept: Array<ValidatedRow<T>> = [];
  const repeats: PlannedRow[] = [];
  for (const row of rows) {
    const key = row.value ? keyOf(row.value) : undefined;
    if (key === undefined) {
      kept.push(row);
      continue;
    }
    const earlier = first.get(key);
    if (earlier !== undefined) repeats.push(refuse(row, `Same ${describe} as row ${earlier}; a file names each one once.`, field));
    else {
      first.set(key, row.rowNumber);
      kept.push(row);
    }
  }
  return { kept, repeats };
}

/** The message a refused write answers with: the API's own words for an HttpException, the error text otherwise. */
export function failureMessage(error: unknown): { message: string; code?: string } {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'string') return { message: body };
    const record = body as { message?: unknown; code?: unknown };
    const message = Array.isArray(record.message) ? record.message.join('; ') : String(record.message ?? error.message);
    return { message, code: typeof record.code === 'string' ? record.code : undefined };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export function money2(value: { toFixed(dp: number): string } | number): string {
  return typeof value === 'number' ? value.toFixed(2) : value.toFixed(2);
}

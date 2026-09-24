/**
 * Pure helpers for turning a raw POS search box value into something that is
 * safe to hand to MySQL fulltext (`MATCH ... AGAINST ... IN BOOLEAN MODE`) and
 * to the fuzzy ranker. Kept free of Nest/Prisma so it can be unit tested.
 */

/** Characters that have operator meaning in MySQL boolean-mode fulltext. */
const BOOLEAN_OPERATORS = /[+\-><()~*"@]/g;

/** Minimum length of a fulltext term; shorter terms are handled by `contains`. */
export const MIN_FULLTEXT_TERM_LENGTH = 2;

/**
 * Strips MySQL boolean-mode operators and collapses whitespace so the term can
 * never produce a fulltext syntax error. Returns an empty string when nothing
 * searchable remains (callers must then skip the fulltext clauses entirely).
 */
export function sanitizeFulltextTerm(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.replace(BOOLEAN_OPERATORS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < MIN_FULLTEXT_TERM_LENGTH) return '';
  return cleaned;
}

/** Trims and collapses whitespace; used for exact code (barcode/SKU) matching. */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Parses a `limit` query value into a bounded positive integer. */
export function parseLimit(value: string | number | undefined, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

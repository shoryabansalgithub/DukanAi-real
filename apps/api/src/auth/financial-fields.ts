import { Role } from '@prisma/client';
import { FINANCE_ROLES } from './role-sets';

/**
 * The money behind the counter that only FINANCE_ROLES see (release audit
 * 2026-10-12): what a product cost, what a sale earned, what the stock is
 * worth at cost, and what the shop owes its suppliers. A key matches when its
 * name contains one of the words (any case: `costPrice`, `unitCost`,
 * `oldCostPrice`, `grossProfit`, `grossMarginPct`, `pendingPayables`,
 * `cogs`) or is one of the exact names (stock valuations).
 *
 * Selling prices, MRP, taxes, discounts, invoice totals, udhar balances and
 * the cash in a drawer are what a cashier works with, and are kept.
 */
const FINANCIAL_KEY = /cost|profit|margin|payable|cogs/i;
const FINANCIAL_EXACT = new Set(['inventoryValue', 'stockValue', 'valuation']);

export function isFinancialField(key: string): boolean {
  return FINANCIAL_KEY.test(key) || FINANCIAL_EXACT.has(key);
}

/** True when `role` may see cost, profit, valuation and payable figures. */
export function canSeeFinancials(role: Role | string | null | undefined): boolean {
  return !!role && (FINANCE_ROLES as readonly string[]).includes(String(role));
}

function isLeaf(value: object): boolean {
  return (
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set ||
    // Streams and Nest's StreamableFile carry bytes, not fields.
    typeof (value as { pipe?: unknown }).pipe === 'function' ||
    typeof (value as { getStream?: unknown }).getStream === 'function'
  );
}

/**
 * A copy of `value` without the financial keys, at any depth. The input is
 * never modified (a cached object may be shared with a manager's answer).
 * Prisma Decimals and other values with `toJSON` are replaced by what
 * `JSON.stringify` would write for them, so the answer serialises the same.
 */
export function withoutFinancialFields<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map((item) => withoutFinancialFields(item, depth + 1)) as T;
  if (isLeaf(value)) return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  const source: unknown = typeof toJSON === 'function' ? toJSON.call(value) : value;
  if (source !== value) return withoutFinancialFields(source, depth + 1) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source as Record<string, unknown>)) {
    if (isFinancialField(key)) continue;
    copy[key] = withoutFinancialFields(item, depth + 1);
  }
  return copy as T;
}

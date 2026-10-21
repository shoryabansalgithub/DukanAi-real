import { isFinancialField } from '../../src/auth/financial-fields';

/** Every key of `value`, at any depth, that only FINANCE_ROLES may receive (`isFinancialField`). */
export function financialKeysIn(value: unknown, found: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) financialKeysIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isFinancialField(key)) found.add(key);
      financialKeysIn(item, found);
    }
  }
  return [...found].sort();
}

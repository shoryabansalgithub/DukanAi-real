export const MAX_DRAWER_AMOUNT = 10_000_000; // ShiftsController DTOs: @Min(0) @Max(10_000_000)

/** Shared with ShiftBanner's modals, which accept the same "0 or more" amount. */
export const DRAWER_AMOUNT_BLANK_MESSAGE = {
  open: 'Enter the cash in the drawer (0 or more).',
  close: 'Enter the cash counted in the drawer (0 or more).',
} as const;

export type DrawerAmountRefusal = 'blank' | 'not-a-number' | 'negative' | 'too-precise' | 'too-large';
export type DrawerAmount = { ok: true; value: number } | { ok: false; reason: DrawerAmountRefusal };

const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Cash typed for a drawer count. Spaces and commas are grouping ("1,25,000"), never part of the number. */
export function parseDrawerAmount(raw: string): DrawerAmount {
  const text = raw.replace(/[\s,]/g, '');
  if (text === '') return { ok: false, reason: 'blank' };
  if (text.startsWith('-') && AMOUNT.test(text.slice(1))) return { ok: false, reason: 'negative' };
  if (!AMOUNT.test(text)) return { ok: false, reason: 'not-a-number' };
  if ((text.split('.')[1] ?? '').length > 2) return { ok: false, reason: 'too-precise' };
  const value = Number(text);
  if (value > MAX_DRAWER_AMOUNT) return { ok: false, reason: 'too-large' };
  return { ok: true, value };
}

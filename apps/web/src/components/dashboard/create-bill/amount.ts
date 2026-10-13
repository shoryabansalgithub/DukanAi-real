export type AmountParse = { ok: true; paise: number } | { ok: false; reason: string };

/** The API's money bound on customer amounts: ₹99,999,999.99. */
const MAX_PAISE = 9_999_999_999;
const MAX_RUPEE_DIGITS = 8;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/**
 * Rupees with up to 2 decimals ("1250", "1,250.5", "0.50"); > 0; <= 99,999,999.99.
 * Integer paise throughout: a float such as 0.1 + 0.2 never reaches the total.
 */
export function parseRupees(input: string): AmountParse {
  const text = input.trim().replace(/,/g, '');
  if (text === '') return { ok: false, reason: 'Enter the bill amount' };
  if (/^-\d*\.?\d*$/.test(text) && /\d/.test(text)) return { ok: false, reason: 'The amount must be more than ₹0' };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || !/\d/.test(text)) return { ok: false, reason: 'Use digits only, like 1250.50' };
  const [, whole, fraction = ''] = match;
  if (fraction.length > 2) return { ok: false, reason: 'Paise go up to two digits' };
  const rupees = whole.replace(/^0+/, '');
  if (rupees.length > MAX_RUPEE_DIGITS) return { ok: false, reason: `That is more than ${formatPaise(MAX_PAISE)}` };
  const paise = Number(rupees || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (paise === 0) return { ok: false, reason: 'The amount must be more than ₹0' };
  if (paise > MAX_PAISE) return { ok: false, reason: `That is more than ${formatPaise(MAX_PAISE)}` };
  return { ok: true, paise };
}

/** "₹1,250.50": always two paise digits, Indian digit grouping. */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

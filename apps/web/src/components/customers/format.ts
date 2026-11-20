/** Display-only formatting helpers. Money math never happens here. */

export function formatMoney(value: number, options: { signed?: boolean } = {}): string {
  const abs = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (value < 0) return `-₹${abs}`;
  return `${options.signed ? '+' : ''}₹${abs}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

/**
 * A business date (`YYYY-MM-DD`, already in the shop's time zone) for display.
 * Read as a calendar date, never as an instant: `new Date('2026-10-11')` is UTC
 * midnight, which a browser west of UTC shows as the day before.
 */
export function formatBusinessDate(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const TENDER_LABELS: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
};

export const PAYMENT_MODE_LABELS: Record<string, string> = {
  ...TENDER_LABELS,
  UDHAR: 'Udhar',
  SPLIT: 'Split',
};

export const LEDGER_TYPE_LABELS: Record<string, string> = {
  CREDIT: 'Credit (udhar)',
  PAYMENT: 'Payment',
  ADJUSTMENT: 'Adjustment',
  WRITEOFF: 'Write-off',
};

export function labelFor(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '—';
  return map[key] ?? key;
}

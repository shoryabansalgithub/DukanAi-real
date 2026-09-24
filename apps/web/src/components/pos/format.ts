/**
 * Display-only formatting for the POS. No money arithmetic lives here.
 */

const INR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const QTY = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export function money(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0.00';
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${INR.format(Math.abs(n))}`;
}

/** Signed variant for round-off / variance rows: "+₹0.40" or "-₹0.40". */
export function signedMoney(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '₹0.00';
  return `${n > 0 ? '+' : '-'}₹${INR.format(Math.abs(n))}`;
}

export function qty(value: number | null | undefined, unit?: string): string {
  const n = Number(value);
  const base = Number.isFinite(n) ? QTY.format(n) : '0';
  return unit ? `${base} ${unit}` : base;
}

export function percent(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${QTY.format(n)}%`;
}

const GST_LABELS: Record<string, string> = {
  ZERO: '0%',
  FIVE: '5%',
  TWELVE: '12%',
  EIGHTEEN: '18%',
  TWENTYEIGHT: '28%',
};

export function gstLabel(rate: string | number | null | undefined): string {
  if (rate === null || rate === undefined) return '';
  if (typeof rate === 'number') return `${rate}%`;
  return GST_LABELS[rate] ?? (/^\d+(\.\d+)?$/.test(rate) ? `${rate}%` : rate);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function dateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** `YYYY-MM-DD` in the browser's local time, for date inputs. */
export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const TENDER_LABELS: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  UDHAR: 'Credit (udhar)',
  CREDIT: 'Credit (udhar)',
  SPLIT: 'Split',
};

export function tenderLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return TENDER_LABELS[value] ?? value;
}

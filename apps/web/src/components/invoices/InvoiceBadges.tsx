import React from 'react';
import Badge from '@/components/ui/Badge';
import type { InvoiceStatus, InvoiceType, PaymentMode } from '@/types';
import { tenderLabel } from '@/components/pos/format';

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const variant = status === 'COMPLETED' ? 'success' : status === 'CANCELLED' ? 'danger' : 'warning';
  const label = status === 'COMPLETED' ? 'Completed' : status === 'CANCELLED' ? 'Cancelled' : 'Draft';
  return <Badge variant={variant}>{label}</Badge>;
}

export function InvoiceTypeBadge({ type }: { type: InvoiceType }) {
  return type === 'SALES_RETURN' ? <Badge variant="warning">Return</Badge> : <Badge variant="primary">Sale</Badge>;
}

export function PaymentModeBadge({ mode }: { mode: PaymentMode | string }) {
  const variant = mode === 'UDHAR' ? 'danger' : mode === 'SPLIT' ? 'warning' : 'default';
  return <Badge variant={variant}>{tenderLabel(mode)}</Badge>;
}

/** Marks an ad-hoc line (`productId: null`): priced as typed, no stock movement. */
export function CustomItemBadge({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="custom-item-badge"
      title="Custom item: not a catalogue product, no stock movement"
      className={`inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ${className}`}
    >
      custom
    </span>
  );
}

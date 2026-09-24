'use client';

import React, { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { CartDiscount } from '@/store/pos';
import type { EngineError, EngineTotals } from './engine';
import { money, signedMoney } from './format';
import { useNumericField } from './useNumericField';

interface TotalsCardProps {
  totals: EngineTotals | null;
  engineError: EngineError | null;
  discount: CartDiscount;
  onDiscountChange: (patch: Partial<CartDiscount>) => void;
  isInterState: boolean;
  shopState: string | null;
  customerState: string | null;
  notes: string;
  onNotesChange: (notes: string) => void;
  hasLines: boolean;
}

const fieldClass =
  'bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

export function TotalsCard({
  totals,
  engineError,
  discount,
  onDiscountChange,
  isInterState,
  shopState,
  customerState,
  notes,
  onNotesChange,
  hasLines,
}: TotalsCardProps) {
  const showReason = discount.value > 0;
  const commitValue = useCallback((value: number) => onDiscountChange({ value: Math.max(0, value) }), [onDiscountChange]);
  const valueField = useNumericField(discount.value, commitValue);

  return (
    <div className="px-4 py-3 space-y-3">
      {/* Invoice discount */}
      <div>
        <div className="flex items-center gap-2">
          <label htmlFor="pos-discount-value" className="text-xs font-bold text-gray-600 w-24 shrink-0">
            Bill discount
          </label>
          <select
            aria-label="Discount type"
            value={discount.type}
            onChange={(e) => onDiscountChange({ type: e.target.value as CartDiscount['type'] })}
            className={`${fieldClass} w-16 px-1.5`}
          >
            <option value="FIXED_AMOUNT">₹</option>
            <option value="PERCENTAGE">%</option>
          </select>
          <input
            id="pos-discount-value"
            type="number"
            inputMode="decimal"
            min={0}
            max={discount.type === 'PERCENTAGE' ? 100 : undefined}
            step="0.01"
            value={valueField.text}
            placeholder="0"
            aria-invalid={Boolean(engineError)}
            aria-describedby={engineError ? 'pos-discount-error' : undefined}
            disabled={!hasLines}
            onChange={(e) => valueField.onChange(e.target.value)}
            className={`${fieldClass} flex-1 min-w-0 disabled:bg-gray-50 ${engineError ? 'border-red-300' : ''}`}
          />
        </div>
        {showReason && (
          <input
            type="text"
            value={discount.reason}
            onChange={(e) => onDiscountChange({ reason: e.target.value })}
            placeholder="Reason for discount (required)"
            aria-label="Discount reason"
            className={`${fieldClass} mt-2 w-full ${engineError?.code === 'ERR_MISSING_DISCOUNT_REASON' ? 'border-red-300' : ''}`}
          />
        )}
        {engineError && (
          <p id="pos-discount-error" role="alert" className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium text-red-600">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{engineError.message}</span>
          </p>
        )}
      </div>

      {/* Notes */}
      <input
        type="text"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        placeholder="Notes on this bill (optional)"
        aria-label="Invoice notes"
        className={`${fieldClass} w-full text-xs`}
      />

      {/* Totals */}
      <dl className="space-y-1.5 text-sm">
        <Row label="Subtotal" value={money(totals?.subtotal)} />
        {(totals?.totalItemDiscount ?? 0) > 0 && <Row label="Item discounts" value={`− ${money(totals?.totalItemDiscount)}`} muted />}
        {(totals?.invoiceDiscount ?? 0) > 0 && <Row label="Bill discount" value={`− ${money(totals?.invoiceDiscount)}`} muted />}
        <Row label="Taxable" value={money(totals?.taxableTotal)} />
        {isInterState ? (
          <Row label="IGST" value={money(totals?.totalIgst)} muted />
        ) : (
          <>
            <Row label="CGST" value={money(totals?.totalCgst)} muted />
            <Row label="SGST" value={money(totals?.totalSgst)} muted />
          </>
        )}
        {(totals?.totalCess ?? 0) > 0 && <Row label="Cess" value={money(totals?.totalCess)} muted />}
        <Row label="Round-off" value={signedMoney(totals?.roundOff)} muted />
        <div className="flex items-baseline justify-between border-t border-gray-200 pt-2 mt-1">
          <dt className="text-sm font-bold text-gray-800">Grand total</dt>
          <dd data-testid="pos-grand-total" className="text-2xl font-extrabold text-gray-900 tabular-nums">
            {engineError ? '—' : money(totals?.finalTotal)}
          </dd>
        </div>
      </dl>
      <p className="text-[10px] text-gray-400">
        {isInterState
          ? `Inter-state supply (IGST): ${customerState ?? '?'} → ${shopState ?? '?'}`
          : shopState
            ? `Intra-state supply (CGST + SGST) · ${shopState}`
            : 'Set the shop state in Settings for correct GST split'}
      </p>
    </div>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-gray-500' : 'text-gray-700 font-medium'}>{label}</dt>
      <dd className={`tabular-nums ${muted ? 'text-gray-600' : 'text-gray-800 font-medium'}`}>{value}</dd>
    </div>
  );
}

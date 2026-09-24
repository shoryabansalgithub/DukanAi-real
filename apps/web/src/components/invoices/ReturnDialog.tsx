'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Undo2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { billingApi } from '@/lib/api-client';
import { generateUuid, allowsDecimalQuantity } from '@/store/pos';
import type { InvoiceDetail, TenderType } from '@/types';
import { extractApiError } from '@/components/pos/api-errors';
import { calculateReturnPreview } from '@/components/pos/engine';
import { money, qty } from '@/components/pos/format';
import { CustomItemBadge } from '@/components/invoices/InvoiceBadges';

interface ReturnDialogProps {
  isOpen: boolean;
  invoice: InvoiceDetail;
  onClose: () => void;
  onReturned: (returnInvoice: InvoiceDetail) => void;
}

const REASONS = [
  { value: 'CUSTOMER_CHANGED_MIND', label: 'Customer changed mind' },
  { value: 'DAMAGED', label: 'Damaged / defective' },
  { value: 'WRONG_ITEM', label: 'Wrong item billed' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'OTHER', label: 'Other' },
];

const TENDERS: TenderType[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];

const fieldClass =
  'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

export function returnableQuantity(item: { quantity: number; returnedQuantity: number }): number {
  return Math.max(0, Number((item.quantity - item.returnedQuantity).toFixed(3)));
}

export function ReturnDialog({ isOpen, invoice, onClose, onReturned }: ReturnDialogProps) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(REASONS[0].value);
  const [notes, setNotes] = useState('');
  const [tender, setTender] = useState<TenderType>('CASH');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const keyRef = useRef<string>('');

  useEffect(() => {
    if (!isOpen) return;
    const initial: Record<string, string> = {};
    invoice.items.forEach((item) => {
      initial[item.id] = String(returnableQuantity(item));
    });
    setQuantities(initial);
    setReason(REASONS[0].value);
    setNotes('');
    setTender('CASH');
    setReference('');
    setError(null);
    keyRef.current = generateUuid();
  }, [isOpen, invoice]);

  const parsed = useMemo(() => {
    const map: Record<string, number> = {};
    const problems: Record<string, string> = {};
    invoice.items.forEach((item) => {
      const raw = quantities[item.id] ?? '';
      const value = raw.trim() === '' ? 0 : Number(raw);
      const max = returnableQuantity(item);
      if (!Number.isFinite(value) || value < 0) problems[item.id] = 'Invalid quantity';
      else if (value > max) problems[item.id] = `Max ${qty(max, item.unit)}`;
      else if (!allowsDecimalQuantity(item.unit) && !Number.isInteger(value)) problems[item.id] = 'Whole numbers only';
      else map[item.id] = value;
    });
    return { map, problems };
  }, [quantities, invoice.items]);

  const preview = useMemo(() => calculateReturnPreview(invoice.items, parsed.map), [invoice.items, parsed.map]);
  const previewTotals = preview.ok ? preview.preview : null;
  const selectedCount = Object.values(parsed.map).filter((v) => v > 0).length;
  const hasProblems = Object.keys(parsed.problems).length > 0;
  const canSubmit = selectedCount > 0 && !hasProblems && preview.ok && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await billingApi.createReturn({
        idempotencyKey: keyRef.current,
        invoiceId: invoice.id,
        items: invoice.items
          .filter((item) => (parsed.map[item.id] ?? 0) > 0)
          .map((item) => ({ invoiceItemId: item.id, quantity: parsed.map[item.id] })),
        reason,
        notes: notes.trim() || undefined,
        refund: { tender, reference: reference.trim() || undefined },
      });
      onReturned(result);
    } catch (err) {
      const info = extractApiError(err, 'Creating return (POST /billing/returns)');
      if (info.code === 'IDEMPOTENCY_KEY_REUSED') {
        keyRef.current = generateUuid();
        setError({ message: 'The request key was already used. A new key was generated — press Retry.', retryable: true });
      } else if (info.code === 'SHIFT_REQUIRED') {
        setError({ message: 'A cash refund needs an open shift. Open a shift from the POS (or refund by UPI/card/bank) and try again.', retryable: false });
      } else if (info.code === 'RETURN_QTY_EXCEEDS') {
        setError({ message: `${info.message} Reload the invoice to see the latest returned quantities.`, retryable: false });
      } else if (info.isNetwork) {
        setError({ message: `${info.message} Retrying reuses the same request key, so no duplicate return is created.`, retryable: true });
      } else {
        setError({ message: info.message, retryable: false });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Return items · ${invoice.invoiceNumber}`} size="lg">
      <div className="space-y-4">
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50/80 text-gray-500 text-[11px] uppercase font-semibold border-b border-gray-100">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Sold</th>
                <th className="px-3 py-2 text-right">Returned</th>
                <th className="px-3 py-2 text-right">Return now</th>
                <th className="px-3 py-2 text-right">Refund</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {invoice.items.map((item) => {
                const max = returnableQuantity(item);
                const problem = parsed.problems[item.id];
                const line = previewTotals?.byLineRef[item.id];
                return (
                  <tr key={item.id} data-testid="return-item" data-custom={item.isCustom ? 'true' : 'false'} className={max === 0 ? 'opacity-50' : ''}>
                    <td className="px-3 py-2">
                      <p className="font-bold text-gray-800 truncate max-w-[220px] flex items-center gap-1.5" title={item.productName}>
                        <span className="truncate">{item.productName}</span>
                        {item.isCustom && <CustomItemBadge className="shrink-0" />}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {money(item.sellingPrice)} / {item.unit}
                        {item.isCustom ? ' · refund only, no stock restore' : ''}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(item.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(item.returnedQuantity)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        inputMode={allowsDecimalQuantity(item.unit) ? 'decimal' : 'numeric'}
                        min={0}
                        max={max}
                        step={allowsDecimalQuantity(item.unit) ? 0.001 : 1}
                        disabled={max === 0}
                        value={quantities[item.id] ?? ''}
                        onChange={(e) => setQuantities((q) => ({ ...q, [item.id]: e.target.value }))}
                        aria-label={`Return quantity for ${item.productName}`}
                        aria-invalid={Boolean(problem)}
                        className={`w-24 text-right bg-white border rounded-lg px-2 py-1.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 ${
                          problem ? 'border-red-300' : 'border-gray-200'
                        }`}
                      />
                      {problem && <p className="text-[10px] text-red-600 mt-0.5">{problem}</p>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{line ? money(line.lineTotal) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="return-reason" className="block text-xs font-bold text-gray-600 mb-1">
              Reason
            </label>
            <select id="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="refund-tender" className="block text-xs font-bold text-gray-600 mb-1">
              Refund via
            </label>
            <select id="refund-tender" value={tender} onChange={(e) => setTender(e.target.value as TenderType)} className={fieldClass}>
              {TENDERS.map((t) => (
                <option key={t} value={t}>
                  {t === 'BANK_TRANSFER' ? 'Bank transfer' : t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          {tender !== 'CASH' && (
            <div>
              <label htmlFor="refund-reference" className="block text-xs font-bold text-gray-600 mb-1">
                Refund reference (optional)
              </label>
              <input id="refund-reference" type="text" value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClass} />
            </div>
          )}
          <div className={tender === 'CASH' ? 'sm:col-span-2' : ''}>
            <label htmlFor="return-notes" className="block text-xs font-bold text-gray-600 mb-1">
              Notes (optional)
            </label>
            <input id="return-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldClass} />
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm">
          {preview.ok ? (
            <dl className="space-y-1">
              <div className="flex justify-between text-gray-600">
                <dt>Taxable</dt>
                <dd className="tabular-nums">{money(previewTotals?.taxableTotal)}</dd>
              </div>
              <div className="flex justify-between text-gray-600">
                <dt>Tax</dt>
                <dd className="tabular-nums">{money(previewTotals?.totalTax)}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
                <dt className="font-bold text-gray-800">Refund total</dt>
                <dd className="font-extrabold text-gray-900 tabular-nums">{money(previewTotals?.finalTotal)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-red-600 flex items-center gap-1.5">
              <AlertTriangle size={14} /> {preview.error.message}
            </p>
          )}
          {invoice.udharAmount > 0 && (
            <p className="mt-2 text-[11px] text-gray-500">
              This sale had {money(invoice.udharAmount)} on credit: the customer&apos;s balance is reduced first and only the remainder is refunded in{' '}
              {tender === 'BANK_TRANSFER' ? 'bank transfer' : tender.toLowerCase()}.
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium">{error.message}</p>
            {error.retryable && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-60"
              >
                <RefreshCw size={13} /> Retry
              </button>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="flex-[2] inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 disabled:cursor-not-allowed text-white font-bold"
          >
            <Undo2 size={16} />
            {submitting ? 'Processing…' : `Return ${selectedCount} ${selectedCount === 1 ? 'item' : 'items'} · ${money(previewTotals?.finalTotal)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

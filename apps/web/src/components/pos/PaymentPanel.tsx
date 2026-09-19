'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Banknote, CreditCard, Landmark, RefreshCw, Smartphone, Split, Wallet, type LucideIcon } from 'lucide-react';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import type { CartDiscount, CartLine } from '@/store/pos';
import type { PosCustomer, TenderType } from '@/types';
import { availableCredit, exceedsCreditLimit, projectedBalance, remainingAfterTenders } from './credit';
import { calculateCart, type EngineTotals, type PaymentSpec } from './engine';
import { money } from './format';

export type PaymentMethod = TenderType | 'CREDIT' | 'SPLIT';

export interface SubmitError {
  code: string | null;
  message: string;
  /** Offer a Retry button that resubmits the same payment (same or rotated key). */
  retryable: boolean;
  details?: Record<string, unknown> | null;
}

interface PaymentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  lines: CartLine[];
  discount: CartDiscount;
  isInterState: boolean;
  /** Preview totals (payment: null) already validated by the page. */
  preview: EngineTotals;
  customer: PosCustomer | null;
  isSubmitting: boolean;
  submitError: SubmitError | null;
  onSubmit: (payment: PaymentSpec) => void;
}

const TENDERS: TenderType[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];
const QUICK_CASH = [100, 200, 500, 2000];

const METHODS: Array<{ id: PaymentMethod; label: string; icon: LucideIcon }> = [
  { id: 'CASH', label: 'Cash', icon: Banknote },
  { id: 'UPI', label: 'UPI', icon: Smartphone },
  { id: 'CARD', label: 'Card', icon: CreditCard },
  { id: 'BANK_TRANSFER', label: 'Bank', icon: Landmark },
  { id: 'CREDIT', label: 'Credit (udhar)', icon: Wallet },
  { id: 'SPLIT', label: 'Split', icon: Split },
];

const fieldClass =
  'w-full bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

type SplitText = Record<TenderType, string>;
const emptySplit = (): SplitText => ({ CASH: '', UPI: '', CARD: '', BANK_TRANSFER: '' });

export function PaymentPanel({
  isOpen,
  onClose,
  lines,
  discount,
  isInterState,
  preview,
  customer,
  isSubmitting,
  submitError,
  onSubmit,
}: PaymentPanelProps) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [splitAmounts, setSplitAmounts] = useState<SplitText>(emptySplit);
  const [splitRefs, setSplitRefs] = useState<SplitText>(emptySplit);
  const [splitCredit, setSplitCredit] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const submitGuard = useRef(false);

  const total = preview.finalTotal;

  useEffect(() => {
    if (!isOpen) return;
    setMethod('CASH');
    setTendered('');
    setReference('');
    setSplitAmounts(emptySplit());
    setSplitRefs(emptySplit());
    setSplitCredit(false);
    submitGuard.current = false;
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 250);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!isSubmitting) submitGuard.current = false;
  }, [isSubmitting]);

  // ---- Build the contract payment from the cashier's choices -------------
  const { spec, uiError } = useMemo((): { spec: PaymentSpec | null; uiError: string | null } => {
    switch (method) {
      case 'CASH': {
        const t = tendered.trim() === '' ? total : Number(tendered);
        if (!Number.isFinite(t) || t < 0) return { spec: null, uiError: 'Enter the cash tendered.' };
        if (t < total) return { spec: null, uiError: 'Cash tendered is less than the bill total. Use Split to add credit or another tender.' };
        return { spec: { tenders: [{ type: 'CASH', amount: total, tenderedAmount: t }] }, uiError: null };
      }
      case 'UPI':
      case 'CARD':
      case 'BANK_TRANSFER':
        return { spec: { tenders: [{ type: method, amount: total, reference: reference.trim() || undefined }] }, uiError: null };
      case 'CREDIT':
        if (!customer) return { spec: null, uiError: 'Select a customer to sell on credit.' };
        return { spec: { tenders: [], udharAmount: total }, uiError: null };
      case 'SPLIT': {
        const tenders = TENDERS.filter((t) => Number(splitAmounts[t]) > 0).map((t) => ({
          type: t,
          amount: Number(splitAmounts[t]),
          reference: t === 'CASH' ? undefined : splitRefs[t].trim() || undefined,
        }));
        const remaining = remainingAfterTenders(
          total,
          tenders.map((t) => t.amount),
        );
        if (remaining < 0) return { spec: null, uiError: `Tenders exceed the bill total by ${money(-remaining)}.` };
        const udhar = splitCredit && remaining > 0 ? remaining : 0;
        if (remaining > 0 && !splitCredit) return { spec: null, uiError: `${money(remaining)} still to be settled.` };
        if (udhar > 0 && !customer) return { spec: null, uiError: 'Select a customer to put the remainder on credit.' };
        if (tenders.length === 0 && udhar === 0 && total > 0) return { spec: null, uiError: 'Enter at least one tender amount.' };
        return { spec: { tenders, udharAmount: udhar }, uiError: null };
      }
      default:
        return { spec: null, uiError: null };
    }
  }, [method, tendered, reference, splitAmounts, splitRefs, splitCredit, total, customer]);

  // ---- Run the engine WITH payment to catch mismatches client-side -------
  const settled = useMemo(() => (spec ? calculateCart({ lines, discount, isInterState, payment: spec }) : null), [
    spec,
    lines,
    discount,
    isInterState,
  ]);

  const settledTotals = settled && settled.ok ? settled.totals : null;
  const engineMessage = settled && !settled.ok ? settled.error.message : null;
  const udharAmount = settledTotals?.payment?.udharAmount ?? spec?.udharAmount ?? 0;
  const changeAmount = settledTotals?.payment?.changeAmount ?? 0;
  const creditWarning = customer && udharAmount > 0 && exceedsCreditLimit(customer, udharAmount);

  const canConfirm = Boolean(spec) && Boolean(settledTotals) && !uiError && !engineMessage && !isSubmitting && lines.length > 0;

  const confirm = () => {
    if (!canConfirm || !spec || submitGuard.current) return;
    submitGuard.current = true;
    onSubmit(spec);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    confirm();
  };

  const splitRemaining = useMemo(() => {
    if (method !== 'SPLIT') return 0;
    return remainingAfterTenders(
      total,
      TENDERS.map((t) => Number(splitAmounts[t]) || 0),
    );
  }, [method, splitAmounts, total]);

  return (
    <SlidingPanel isOpen={isOpen} onClose={onClose} title="Take payment" width="max-w-lg">
      <div onKeyDown={handleKeyDown} className="space-y-5">
        {/* Amount due */}
        <div className="rounded-2xl bg-gray-900 text-white p-5">
          <p className="text-xs uppercase tracking-wider text-gray-400 font-bold">Amount due</p>
          <p data-testid="payment-amount-due" className="text-4xl font-extrabold tabular-nums mt-1">
            {money(total)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">
            {lines.length} {lines.length === 1 ? 'item' : 'items'}
            {customer ? ` · ${customer.name}` : ' · Walk-in customer'}
          </p>
        </div>

        {/* Tender buttons */}
        <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2">
          {METHODS.map(({ id, label, icon: Icon }) => {
            const active = method === id;
            const disabled = id === 'CREDIT' && !customer;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                title={disabled ? 'Select a customer to sell on credit' : undefined}
                onClick={() => setMethod(id)}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  active ? 'border-[#8B5CF6] bg-purple-50 text-[#8B5CF6] ring-1 ring-[#8B5CF6]' : 'border-gray-200 text-gray-600 hover:border-[#8B5CF6]/50'
                }`}
              >
                <Icon size={18} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Method-specific inputs */}
        {method === 'CASH' && (
          <div className="space-y-3">
            <div>
              <label htmlFor="cash-tendered" className="block text-xs font-bold text-gray-600 mb-1.5">
                Cash tendered (₹) — leave blank for exact
              </label>
              <input
                ref={firstFieldRef}
                id="cash-tendered"
                data-testid="cash-tendered"
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={String(total)}
                className={`${fieldClass} text-lg`}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setTendered(String(total))} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50">
                Exact
              </button>
              {QUICK_CASH.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setTendered(String(amount))}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50"
                >
                  ₹{amount}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between rounded-xl bg-green-50 border border-green-100 px-4 py-3">
              <span className="text-sm font-bold text-green-800">Change to return</span>
              <span data-testid="cash-change" className="text-xl font-extrabold text-green-700 tabular-nums">
                {money(settledTotals ? changeAmount : 0)}
              </span>
            </div>
          </div>
        )}

        {(method === 'UPI' || method === 'CARD' || method === 'BANK_TRANSFER') && (
          <div>
            <label htmlFor="tender-reference" className="block text-xs font-bold text-gray-600 mb-1.5">
              Reference / transaction ID (optional)
            </label>
            <input
              ref={firstFieldRef}
              id="tender-reference"
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={method === 'UPI' ? 'UPI ref no.' : method === 'CARD' ? 'Approval code' : 'UTR / ref'}
              className={fieldClass}
            />
          </div>
        )}

        {method === 'CREDIT' && customer && (
          <CreditSummary customer={customer} udharAmount={total} />
        )}

        {method === 'SPLIT' && (
          <div className="space-y-2">
            {TENDERS.map((t, index) => (
              <div key={t} className="grid grid-cols-[88px_1fr_1fr] gap-2 items-center">
                <span className="text-xs font-bold text-gray-600">{METHODS.find((m) => m.id === t)?.label}</span>
                <input
                  ref={index === 0 ? firstFieldRef : undefined}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={splitAmounts[t]}
                  onChange={(e) => setSplitAmounts((s) => ({ ...s, [t]: e.target.value }))}
                  placeholder="0.00"
                  aria-label={`${t} amount`}
                  className={fieldClass}
                />
                {t === 'CASH' ? (
                  <span className="text-[11px] text-gray-400">no change on split cash</span>
                ) : (
                  <input
                    type="text"
                    value={splitRefs[t]}
                    onChange={(e) => setSplitRefs((s) => ({ ...s, [t]: e.target.value }))}
                    placeholder="Ref (optional)"
                    aria-label={`${t} reference`}
                    className={`${fieldClass} font-medium`}
                  />
                )}
              </div>
            ))}
            <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold ${customer ? 'border-gray-200 text-gray-700' : 'border-gray-100 text-gray-400'}`}>
              <input type="checkbox" checked={splitCredit} disabled={!customer} onChange={(e) => setSplitCredit(e.target.checked)} className="accent-[#8B5CF6]" />
              Put the remainder on credit{customer ? ` (${customer.name})` : ' — select a customer first'}
            </label>
            <div
              className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                splitRemaining < 0
                  ? 'bg-red-50 border-red-100 text-red-700'
                  : splitRemaining === 0 || (splitCredit && customer)
                    ? 'bg-green-50 border-green-100 text-green-800'
                    : 'bg-amber-50 border-amber-100 text-amber-800'
              }`}
              aria-live="polite"
            >
              <span className="text-sm font-bold">{splitRemaining < 0 ? 'Over by' : splitCredit && splitRemaining > 0 ? 'On credit' : 'Remaining'}</span>
              <span className="text-xl font-extrabold tabular-nums">{money(Math.abs(splitRemaining))}</span>
            </div>
            {customer && splitCredit && splitRemaining > 0 && <CreditSummary customer={customer} udharAmount={splitRemaining} />}
          </div>
        )}

        {/* Validation */}
        {(uiError || engineMessage) && (
          <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-red-600">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{uiError ?? engineMessage}</span>
          </p>
        )}
        {creditWarning && !uiError && !engineMessage && (
          <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>This sale takes the customer over their credit limit. The server will reject it unless a manager override applies.</span>
          </p>
        )}

        {/* Server errors */}
        {submitError && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
            <p className="font-bold text-red-800">{submitError.message}</p>
            {submitError.code && <p className="text-[11px] text-red-600 mt-0.5 font-mono">{submitError.code}</p>}
            {submitError.retryable && (
              <button
                type="button"
                onClick={() => {
                  submitGuard.current = false;
                  confirm();
                }}
                disabled={isSubmitting}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-60"
              >
                <RefreshCw size={13} /> Retry
              </button>
            )}
          </div>
        )}

        {/* Confirm */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 disabled:opacity-60"
          >
            Back
          </button>
          <button
            type="button"
            data-testid="payment-confirm"
            onClick={confirm}
            disabled={!canConfirm}
            className="flex-[2] py-3 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:bg-purple-300 disabled:cursor-not-allowed text-white font-bold shadow-lg shadow-purple-500/30 transition-colors"
          >
            {isSubmitting ? 'Saving…' : `Confirm ${money(total)}`}
          </button>
        </div>
        <p className="text-center text-[11px] text-gray-400">Enter confirms · Esc goes back</p>
      </div>
    </SlidingPanel>
  );
}

function CreditSummary({ customer, udharAmount }: { customer: PosCustomer; udharAmount: number }) {
  const available = availableCredit(customer);
  const projected = projectedBalance(customer, udharAmount);
  const over = exceedsCreditLimit(customer, udharAmount);
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs">
      <div>
        <dt className="text-gray-500">On credit now</dt>
        <dd className="font-bold text-gray-800">{money(udharAmount)}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Available credit</dt>
        <dd className={`font-bold ${available <= 0 ? 'text-red-600' : 'text-green-700'}`}>{money(available)}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Current balance</dt>
        <dd className="font-bold text-gray-800">{money(customer.outstandingBalance)}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Projected balance</dt>
        <dd className={`font-bold ${over ? 'text-red-600' : 'text-gray-800'}`}>
          {money(projected)} <span className="font-normal text-gray-400">/ {money(customer.creditLimit)}</span>
        </dd>
      </div>
    </dl>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  customersApi,
  type CustomerLedgerEntry,
  type CustomerTender,
  type CustomerView,
} from '@/lib/api-client';
import { describeApiError, getApiErrorCode, getApiErrorDetails, getApiErrorStatus } from '@/lib/api-error';
import { formatMoney, TENDER_LABELS } from './format';

const TENDERS: CustomerTender[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];

const inputClass =
  'w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all disabled:bg-gray-50 disabled:text-gray-500';
const labelClass = 'text-xs font-bold text-gray-600 uppercase tracking-wide';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface RecordPaymentResult {
  customer: CustomerView;
  transaction: CustomerLedgerEntry;
}

interface RecordPaymentModalProps {
  isOpen: boolean;
  customer: Pick<CustomerView, 'id' | 'name' | 'outstandingBalance'> | null;
  onClose: () => void;
  onRecorded: (result: RecordPaymentResult) => void;
}

/**
 * `POST /customers/:id/payments`. One idempotency key is generated per modal
 * open and reused when the same submission is retried after a network / 5xx
 * failure. A business rejection (4xx) means the next submit is a new intent,
 * so the key is rotated then.
 */
export function RecordPaymentModal({ isOpen, customer, onClose, onRecorded }: RecordPaymentModalProps) {
  const { toast } = useToast();
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [tender, setTender] = useState<CustomerTender>('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allowAdvance, setAllowAdvance] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [exceeds, setExceeds] = useState<{ outstanding: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setIdempotencyKey(newIdempotencyKey());
    setAmount('');
    setTender('CASH');
    setReference('');
    setNotes('');
    setAllowAdvance(false);
    setSubmitting(false);
    setFormError(null);
    setExceeds(null);
  }, [isOpen, customer?.id]);

  const outstanding = customer?.outstandingBalance ?? 0;
  const amountNumber = Number(amount);
  const amountValid = Number.isFinite(amountNumber) && amountNumber > 0;
  const willExceed = amountValid && amountNumber > outstanding && !allowAdvance;

  const submit = async (overrideAllowAdvance?: boolean) => {
    if (!customer || submitting) return;
    if (!amountValid) {
      setFormError('Enter an amount greater than zero.');
      return;
    }
    const advance = overrideAllowAdvance ?? allowAdvance;

    setSubmitting(true);
    setFormError(null);
    setExceeds(null);
    try {
      const result = await customersApi.recordPayment(customer.id, {
        idempotencyKey,
        amount: amountNumber,
        tender,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        allowAdvance: advance || undefined,
      });
      toast(`${formatMoney(amountNumber)} received from ${customer.name}`, 'success');
      onRecorded(result);
      onClose();
    } catch (error) {
      const code = getApiErrorCode(error);
      const status = getApiErrorStatus(error);
      if (code === 'PAYMENT_EXCEEDS_OUTSTANDING') {
        const details = getApiErrorDetails(error);
        const serverOutstanding = Number(details?.outstandingBalance ?? details?.outstanding ?? outstanding);
        setExceeds({ outstanding: Number.isFinite(serverOutstanding) ? serverOutstanding : outstanding });
      } else {
        const message = describeApiError(error, 'Recording payment (POST /customers/:id/payments)');
        setFormError(code ? `${message} [${code}]` : message);
      }
      // The server rejected this intent; a corrected submission is a new one.
      if (status !== undefined && status >= 400 && status < 500 && status !== 401) {
        setIdempotencyKey(newIdempotencyKey());
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const enableAdvanceAndRetry = () => {
    setAllowAdvance(true);
    void submit(true);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={customer ? `Record payment — ${customer.name}` : 'Record payment'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="flex items-center justify-between rounded-xl border border-orange-100 bg-orange-50/60 px-4 py-3">
          <span className="text-xs font-medium text-gray-600">Outstanding balance</span>
          <span className={`text-sm font-bold ${outstanding > 0 ? 'text-orange-600' : outstanding < 0 ? 'text-blue-600' : 'text-green-600'}`}>
            {outstanding < 0 ? `Advance ${formatMoney(Math.abs(outstanding))}` : formatMoney(outstanding)}
          </span>
        </div>

        <div>
          <label htmlFor="payment-amount" className={labelClass}>Amount received (₹) *</label>
          <input
            id="payment-amount"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            required
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            disabled={submitting}
            className={`${inputClass} text-lg font-bold`}
          />
          {willExceed && !exceeds && (
            <p className="mt-1 text-[11px] text-orange-600">
              Exceeds the outstanding balance by {formatMoney(amountNumber - outstanding)}. Tick "Allow advance" to keep the excess as store credit.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="payment-tender" className={labelClass}>Tender</label>
          <select
            id="payment-tender"
            value={tender}
            onChange={(e) => setTender(e.target.value as CustomerTender)}
            disabled={submitting}
            className={inputClass}
          >
            {TENDERS.map((option) => (
              <option key={option} value={option}>{TENDER_LABELS[option]}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="payment-reference" className={labelClass}>Reference</label>
          <input
            id="payment-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={100}
            placeholder={tender === 'CASH' ? 'Optional' : 'UTR / transaction id'}
            disabled={submitting}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="payment-notes" className={labelClass}>Notes</label>
          <textarea
            id="payment-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Paid for last week's bill"
            disabled={submitting}
            className={inputClass}
          />
        </div>

        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={allowAdvance}
            onChange={(e) => setAllowAdvance(e.target.checked)}
            disabled={submitting}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[#8B5CF6] focus:ring-[#8B5CF6]"
          />
          <span>
            Allow advance
            <span className="block text-[11px] text-gray-500">Accept more than the outstanding balance; the excess becomes store credit.</span>
          </span>
        </label>

        {exceeds && (
          <div role="alert" className="flex gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-orange-500" />
            <div className="flex-1">
              <p className="font-bold">Payment exceeds the outstanding balance</p>
              <p className="mt-0.5">
                This customer owes {formatMoney(exceeds.outstanding)}. Record {formatMoney(amountNumber)} anyway and keep{' '}
                {formatMoney(Math.max(amountNumber - exceeds.outstanding, 0))} as an advance?
              </p>
              <button
                type="button"
                onClick={enableAdvanceAndRetry}
                disabled={submitting}
                className="mt-2 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-orange-600 disabled:opacity-60"
              >
                Enable advance and record
              </button>
            </div>
          </div>
        )}

        {formError && (
          <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
            {formError}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !customer}
            className="rounded-lg bg-green-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-green-500/30 transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { billingApi } from '@/lib/api-client';
import type { InvoiceDetail } from '@/types';
import { extractApiError } from '@/components/pos/api-errors';
import { money } from '@/components/pos/format';

interface CancelDialogProps {
  isOpen: boolean;
  invoice: InvoiceDetail;
  onClose: () => void;
  onCancelled: (updated: InvoiceDetail) => void;
}

export function CancelDialog({ isOpen, invoice, onClose, onCancelled }: CancelDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setError(null);
    }
  }, [isOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('A reason is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onCancelled(await billingApi.cancelInvoice(invoice.id, reason.trim()));
    } catch (err) {
      const info = extractApiError(err, 'Cancelling invoice (POST /billing/invoices/:id/cancel)');
      setError(
        info.code === 'INVOICE_NOT_CANCELLABLE'
          ? `${info.message} Only a completed sale from today with no returns can be cancelled; use a return instead.`
          : info.status === 403
            ? 'Only managers and above can cancel invoices.'
            : info.message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <form onSubmit={submit} className="flex flex-col items-center text-center">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-red-100 text-red-600">
          <AlertTriangle size={24} />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-1">Cancel {invoice.invoiceNumber}?</h3>
        <p className="text-sm text-gray-600 mb-4">
          Stock, credit, shift and ledger entries for {money(invoice.totalAmount)} will be reversed. The invoice keeps its number and is marked cancelled.
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Reason for cancellation (required)"
          aria-label="Cancellation reason"
          className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600 text-left w-full">
            {error}
          </p>
        )}
        <div className="flex gap-3 w-full mt-5">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 py-2.5 px-4 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50">
            Keep invoice
          </button>
          <button type="submit" disabled={submitting} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60">
            {submitting ? 'Cancelling…' : 'Cancel invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

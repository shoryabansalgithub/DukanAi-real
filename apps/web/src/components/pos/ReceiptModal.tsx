'use client';

import React from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, Printer } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { CreateInvoiceResponse } from '@/types';
import { money, tenderLabel } from './format';

interface ReceiptModalProps {
  result: CreateInvoiceResponse | null;
  onNewSale: () => void;
}

export function openReceiptWindow(invoiceId: string): void {
  window.open(`/invoices/${invoiceId}/receipt?autoprint=1`, '_blank', 'noopener');
}

export function ReceiptModal({ result, onNewSale }: ReceiptModalProps) {
  const invoice = result?.invoice ?? null;
  return (
    <Modal isOpen={Boolean(result)} onClose={onNewSale} size="sm">
      {invoice && (
        <div className="text-center" data-testid="receipt-modal" data-invoice-id={invoice.id}>
          <div className="mx-auto w-14 h-14 rounded-full bg-green-100 text-green-600 flex items-center justify-center mb-3">
            <CheckCircle2 size={30} />
          </div>
          <h3 className="text-lg font-bold text-gray-900">Sale complete</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Invoice{' '}
            <span data-testid="receipt-invoice-number" className="font-mono font-bold text-gray-800">
              {invoice.invoiceNumber}
            </span>
          </p>

          <dl className="mt-5 space-y-1.5 text-sm text-left rounded-xl border border-gray-100 bg-gray-50/60 p-4">
            <div className="flex justify-between">
              <dt className="text-gray-500">Grand total</dt>
              <dd data-testid="receipt-total" className="font-bold text-gray-900 tabular-nums">
                {money(invoice.totalAmount)}
              </dd>
            </div>
            {invoice.payments.map((p) => (
              <div key={p.id || p.tender} className="flex justify-between">
                <dt className="text-gray-500">
                  {tenderLabel(p.tender)}
                  {p.reference ? <span className="text-gray-400"> · {p.reference}</span> : null}
                </dt>
                <dd className="text-gray-800 tabular-nums">{money(p.amount)}</dd>
              </div>
            ))}
            {invoice.udharAmount > 0 && (
              <div className="flex justify-between">
                <dt className="text-gray-500">On credit</dt>
                <dd className="text-red-600 font-medium tabular-nums">{money(invoice.udharAmount)}</dd>
              </div>
            )}
            {invoice.changeAmount > 0 && (
              <div className="flex justify-between border-t border-gray-200 pt-2 mt-1">
                <dt className="font-bold text-green-800">Change due</dt>
                <dd data-testid="receipt-change" className="text-xl font-extrabold text-green-700 tabular-nums">
                  {money(invoice.changeAmount)}
                </dd>
              </div>
            )}
          </dl>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => openReceiptWindow(invoice.id)}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              <Printer size={16} /> Print
            </button>
            <Link
              href={`/invoices/${invoice.id}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50"
            >
              <ExternalLink size={16} /> View invoice
            </Link>
          </div>
          <button
            type="button"
            autoFocus
            data-testid="receipt-new-sale"
            onClick={onNewSale}
            className="mt-2 w-full rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] py-3 text-sm font-bold text-white shadow-lg shadow-purple-500/30"
          >
            New sale
          </button>
          <p className="mt-2 text-[11px] text-gray-400">Enter starts the next sale</p>
        </div>
      )}
    </Modal>
  );
}

'use client';

import React from 'react';
import Link from 'next/link';
import type { CustomerInvoiceSummary } from '@/lib/api-client';
import { formatDateTime, formatMoney, labelFor, PAYMENT_MODE_LABELS } from './format';

const STATUS_BADGE: Record<string, string> = {
  COMPLETED: 'bg-green-50 text-green-600',
  PAID: 'bg-green-50 text-green-600',
  PENDING: 'bg-orange-50 text-orange-600',
  PARTIAL: 'bg-orange-50 text-orange-600',
  CANCELLED: 'bg-red-50 text-red-600',
};

export function CustomerInvoicesTable({ invoices }: { invoices: CustomerInvoiceSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-gray-600">
        <thead className="border-b border-gray-100 bg-gray-50/80 text-xs font-semibold uppercase text-gray-500">
          <tr>
            <th className="px-5 py-3">Date</th>
            <th className="px-5 py-3">Invoice</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3">Mode</th>
            <th className="px-5 py-3 text-right">Total</th>
            <th className="px-5 py-3 text-right">Paid</th>
            <th className="px-5 py-3 text-right">On credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {invoices.map((invoice) => {
            const isReturn = invoice.type === 'SALES_RETURN';
            return (
              <tr key={invoice.id} className="transition-colors hover:bg-gray-50/60">
                <td className="whitespace-nowrap px-5 py-3 text-gray-700">{formatDateTime(invoice.createdAt)}</td>
                <td className="px-5 py-3">
                  <Link href={`/invoices/${invoice.id}`} className="font-bold text-[#8B5CF6] hover:underline">
                    {invoice.invoiceNumber || 'View invoice'}
                  </Link>
                  {isReturn && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">Return</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${STATUS_BADGE[invoice.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {invoice.status || '—'}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-700">{labelFor(PAYMENT_MODE_LABELS, invoice.paymentMode)}</td>
                <td className="whitespace-nowrap px-5 py-3 text-right font-bold text-gray-800">
                  {isReturn ? '-' : ''}{formatMoney(invoice.totalAmount)}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">{formatMoney(invoice.paidAmount)}</td>
                <td className={`whitespace-nowrap px-5 py-3 text-right ${invoice.udharAmount > 0 ? 'font-semibold text-orange-600' : ''}`}>
                  {formatMoney(invoice.udharAmount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import React from 'react';
import Link from 'next/link';
import type { CustomerLedgerEntry } from '@/lib/api-client';
import { formatDateTime, formatMoney, labelFor, LEDGER_TYPE_LABELS, TENDER_LABELS } from './format';

const TYPE_BADGE: Record<string, string> = {
  CREDIT: 'bg-orange-50 text-orange-600',
  PAYMENT: 'bg-green-50 text-green-600',
  ADJUSTMENT: 'bg-blue-50 text-blue-600',
  WRITEOFF: 'bg-gray-100 text-gray-600',
};

/** Whether this ledger row increased what the customer owes. */
function increasesBalance(entry: CustomerLedgerEntry): boolean {
  return entry.balanceAfter > entry.balanceBefore;
}

export function LedgerTable({ entries }: { entries: CustomerLedgerEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-gray-600">
        <thead className="border-b border-gray-100 bg-gray-50/80 text-xs font-semibold uppercase text-gray-500">
          <tr>
            <th className="px-5 py-3">Date</th>
            <th className="px-5 py-3">Type</th>
            <th className="px-5 py-3">Tender / reference</th>
            <th className="px-5 py-3">Invoice</th>
            <th className="px-5 py-3 text-right">Amount</th>
            <th className="px-5 py-3 text-right">Balance after</th>
            <th className="px-5 py-3">Recorded by</th>
            <th className="px-5 py-3">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {entries.map((entry) => {
            const up = increasesBalance(entry);
            return (
              <tr key={entry.id} className="transition-colors hover:bg-gray-50/60">
                <td className="whitespace-nowrap px-5 py-3 text-gray-700">{formatDateTime(entry.createdAt)}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${TYPE_BADGE[entry.type] ?? 'bg-gray-100 text-gray-600'}`}>
                    {labelFor(LEDGER_TYPE_LABELS, entry.type)}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {entry.tender ? (
                    <span className="font-medium text-gray-800">{labelFor(TENDER_LABELS, entry.tender)}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                  {entry.reference && <span className="block text-[11px] text-gray-500">Ref: {entry.reference}</span>}
                </td>
                <td className="px-5 py-3">
                  {entry.invoice ? (
                    <Link href={`/invoices/${entry.invoice.id}`} className="font-bold text-[#8B5CF6] hover:underline">
                      {entry.invoice.invoiceNumber || 'View invoice'}
                    </Link>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className={`whitespace-nowrap px-5 py-3 text-right font-bold ${up ? 'text-orange-600' : 'text-green-600'}`}>
                  {up ? '+' : '-'}{formatMoney(entry.amount)}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right font-semibold text-gray-800">
                  {entry.balanceAfter < 0 ? `Advance ${formatMoney(Math.abs(entry.balanceAfter))}` : formatMoney(entry.balanceAfter)}
                </td>
                <td className="px-5 py-3 text-gray-700">{entry.recordedBy?.name ?? '—'}</td>
                <td className="max-w-[220px] truncate px-5 py-3 text-gray-500" title={entry.notes ?? undefined}>{entry.notes ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

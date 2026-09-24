'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, RefreshCw, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SkeletonTable } from '@/components/ui/Skeleton';
import { billingApi } from '@/lib/api-client';
import { useDebounce } from '@/hooks/useDebounce';
import type { InvoiceStatus, InvoiceSummary, InvoiceType } from '@/types';
import { extractApiError } from '@/components/pos/api-errors';
import { dateTime, money, toDateInputValue } from '@/components/pos/format';
import { InvoiceStatusBadge, InvoiceTypeBadge, PaymentModeBadge } from '@/components/invoices/InvoiceBadges';
import { Pagination } from '@/components/invoices/Pagination';

const TAKE = 25;

const fieldClass =
  'bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

export default function InvoicesPage() {
  const router = useRouter();
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [type, setType] = useState<InvoiceType | ''>('');
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [q, setQ] = useState('');
  const [skip, setSkip] = useState(0);
  const [items, setItems] = useState<InvoiceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const debouncedQ = useDebounce(q.trim(), 300);

  useEffect(() => {
    setSkip(0);
  }, [from, to, type, status, debouncedQ]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    billingApi
      .listInvoices({ from, to, type, status, q: debouncedQ || undefined, skip, take: TAKE }, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        const info = extractApiError(err, 'Loading invoices (GET /billing/invoices)');
        if (!info.isCanceled && !controller.signal.aborted) setError(info.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, type, status, debouncedQ, skip, retry]);

  const open = useCallback((id: string) => router.push(`/invoices/${id}`), [router]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Invoices</h1>
          <p className="text-sm text-gray-500 mt-1">Sales and returns, by business day.</p>
        </div>
        <button
          type="button"
          onClick={() => router.push('/billing')}
          className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-purple-500/30 transition-all"
        >
          New sale
        </button>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-gray-100 bg-gray-50/50 grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <label className="text-xs font-medium text-gray-500">
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`${fieldClass} mt-1 w-full`} />
          </label>
          <label className="text-xs font-medium text-gray-500">
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={`${fieldClass} mt-1 w-full`} />
          </label>
          <label className="text-xs font-medium text-gray-500">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as InvoiceType | '')} className={`${fieldClass} mt-1 w-full`}>
              <option value="">All</option>
              <option value="SALE">Sales</option>
              <option value="SALES_RETURN">Returns</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-500">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className={`${fieldClass} mt-1 w-full`}>
              <option value="">All</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="DRAFT">Draft</option>
            </select>
          </label>
          <label className="col-span-2 text-xs font-medium text-gray-500">
            Invoice number
            <div className="relative mt-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. INV-2026-0042" className={`${fieldClass} w-full pl-9`} />
            </div>
          </label>
        </div>

        <div className="overflow-x-auto min-h-[300px]">
          {loading && items.length === 0 ? (
            <div className="p-6">
              <SkeletonTable rows={8} cols={7} />
            </div>
          ) : error ? (
            <div role="alert" className="flex min-h-[300px] items-center justify-center px-6 text-center">
              <div>
                <p className="font-medium text-gray-800">Unable to load invoices</p>
                <p className="mt-1 text-xs text-gray-500">{error}</p>
                <button
                  type="button"
                  onClick={() => setRetry((n) => n + 1)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] px-4 py-2 text-sm font-bold text-white shadow-lg shadow-purple-500/30 hover:bg-[#7C3AED]"
                >
                  <RefreshCw size={14} /> Retry
                </button>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center text-gray-400">
              <FileText size={40} className="opacity-25 mb-3" />
              <p className="text-sm font-medium">No invoices for this range</p>
              <p className="text-xs mt-1">Widen the dates or clear the filters.</p>
            </div>
          ) : (
            <table className={`w-full text-left text-sm text-gray-600 ${loading ? 'opacity-60' : ''}`}>
              <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase font-semibold border-b border-gray-100">
                <tr>
                  <th className="px-5 py-3">Number</th>
                  <th className="px-5 py-3">Time</th>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Cashier</th>
                  <th className="px-5 py-3">Mode</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.map((inv) => (
                  <tr
                    key={inv.id}
                    onClick={() => open(inv.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') open(inv.id);
                    }}
                    tabIndex={0}
                    className="hover:bg-gray-50/60 transition-colors cursor-pointer focus:outline-none focus:bg-purple-50"
                  >
                    <td className="px-5 py-3">
                      <span className="font-mono font-bold text-gray-800">{inv.invoiceNumber}</span>
                      <span className="block text-[11px] text-gray-400">
                        {inv.itemCount} {inv.itemCount === 1 ? 'item' : 'items'}
                      </span>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">{dateTime(inv.createdAt)}</td>
                    <td className="px-5 py-3">{inv.customer?.name ?? <span className="text-gray-400">Walk-in</span>}</td>
                    <td className="px-5 py-3">{inv.cashier?.name ?? '—'}</td>
                    <td className="px-5 py-3">
                      <PaymentModeBadge mode={inv.paymentMode} />
                    </td>
                    <td className="px-5 py-3 text-right font-bold text-gray-800 tabular-nums whitespace-nowrap">
                      {inv.type === 'SALES_RETURN' ? '-' : ''}
                      {money(inv.totalAmount)}
                      {inv.udharAmount > 0 && <span className="block text-[11px] font-medium text-red-500">udhar {money(inv.udharAmount)}</span>}
                      {inv.returnedAmount > 0 && <span className="block text-[11px] font-medium text-amber-600">returned {money(inv.returnedAmount)}</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        <InvoiceTypeBadge type={inv.type} />
                        <InvoiceStatusBadge status={inv.status} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {!error && total > 0 && <Pagination skip={skip} take={TAKE} total={total} onChange={setSkip} disabled={loading} />}
      </Card>
    </div>
  );
}

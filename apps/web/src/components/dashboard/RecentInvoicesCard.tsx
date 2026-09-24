'use client';

import React from 'react';
import Link from 'next/link';
import { Receipt, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { DashboardRecentInvoice } from '@/lib/api-client';
import { formatMoney, formatTime, labelFor, PAYMENT_MODE_LABELS } from '@/components/customers/format';

interface RecentInvoicesCardProps {
  invoices: DashboardRecentInvoice[];
  className?: string;
}

export function RecentInvoicesCard({ invoices, className = '' }: RecentInvoicesCardProps) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-gray-800">Recent invoices</h3>
        <Link href="/invoices" className="text-xs font-semibold text-[#8B5CF6] hover:text-[#7C3AED]">View all</Link>
      </div>
      <div className="space-y-3">
        {invoices.length === 0 && <p className="py-2 text-center text-xs text-gray-500">No invoices yet today.</p>}
        {invoices.map((invoice) => {
          const isReturn = invoice.type === 'SALES_RETURN';
          const isCancelled = invoice.status === 'CANCELLED';
          return (
            <Link
              key={invoice.id}
              href={`/invoices/${invoice.id}`}
              className="-mx-1 flex items-center justify-between rounded-lg p-1 transition-colors hover:bg-gray-50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isReturn ? 'bg-red-100 text-red-500' : 'bg-blue-100 text-blue-500'}`}>
                  {isReturn ? <RotateCcw size={14} /> : <Receipt size={14} />}
                </div>
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-[11px] font-bold text-gray-800">
                    <span className="truncate">{invoice.customer?.name ?? 'Walk-in customer'}</span>
                    {isReturn && <span className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-600">Return</span>}
                    {isCancelled && <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-600">Cancelled</span>}
                  </p>
                  <p className="text-[10px] text-gray-400">
                    #{invoice.invoiceNumber} · {labelFor(PAYMENT_MODE_LABELS, invoice.paymentMode)} · {formatTime(invoice.createdAt)}
                  </p>
                </div>
              </div>
              <span className={`shrink-0 text-xs font-bold ${isCancelled ? 'text-gray-400 line-through' : isReturn ? 'text-red-500' : 'text-green-500'}`}>
                {isReturn ? '-' : ''}{formatMoney(invoice.totalAmount)}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

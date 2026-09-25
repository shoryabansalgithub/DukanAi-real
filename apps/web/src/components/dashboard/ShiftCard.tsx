'use client';

import React from 'react';
import Link from 'next/link';
import { Clock, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { DashboardShift } from '@/lib/api-client';
import { formatMoney, formatTime } from '@/components/customers/format';
import { CardSkeletonRows, CardUnavailable } from './CardStates';

interface ShiftCardProps {
  shift: DashboardShift | null;
  loading?: boolean;
  unavailable?: boolean;
  onRetry?: () => void;
  className?: string;
}

/** The caller's OPEN shift from `GET /dashboard/summary`, or a prompt to open one. */
export function ShiftCard({ shift, loading = false, unavailable = false, onRetry, className = '' }: ShiftCardProps) {
  if (loading || unavailable) {
    return (
      <Card className={`flex flex-col justify-between p-5 ${className}`}>
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-gray-800">
            <Clock size={16} className="text-gray-400" /> Shift
          </h3>
          {loading ? (
            <CardSkeletonRows rows={4} />
          ) : (
            <CardUnavailable message="Your shift status could not be loaded." onRetry={onRetry} />
          )}
        </div>
      </Card>
    );
  }

  if (!shift) {
    return (
      <Card className={`flex flex-col justify-between p-5 ${className}`}>
        <div>
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
            <Clock size={16} className="text-gray-400" /> Shift
          </h3>
          <p className="mt-3 text-sm text-gray-600">No shift is open for you right now.</p>
          <p className="mt-1 text-xs text-gray-500">Open one from Billing before taking cash so the drawer can be reconciled.</p>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
          <Link href="/billing" className="flex items-center gap-1 text-xs font-bold text-[#8B5CF6] hover:text-[#7C3AED]">
            Go to Billing <ArrowRight size={12} />
          </Link>
          <Link href="/shifts" className="text-xs font-semibold text-gray-500 hover:text-gray-800">Shift history</Link>
        </div>
      </Card>
    );
  }

  const tenders = [
    { label: 'Cash', amount: shift.cashSales },
    { label: 'UPI', amount: shift.upiSales },
    { label: 'Card', amount: shift.cardSales },
    { label: 'Udhar', amount: shift.udharSales },
  ];

  return (
    <Card className={`flex flex-col justify-between border-green-100 bg-gradient-to-br from-green-50/60 to-white p-5 ${className}`}>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
            <Clock size={16} className="text-green-500" /> Open shift
          </h3>
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">{shift.status}</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          Opened {formatTime(shift.openedAt)}{shift.openedBy ? ` by ${shift.openedBy.name}` : ''}
        </p>

        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500">Expected cash in drawer</p>
          <p className="text-2xl font-bold tracking-tight text-gray-800">{formatMoney(shift.expectedCash)}</p>
          <p className="text-[10px] text-gray-500">Opening {formatMoney(shift.openingCash)} · Receipts {formatMoney(shift.totalReceipts)}</p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {tenders.map((tender) => (
            <div key={tender.label} className="flex items-center justify-between">
              <dt className="text-gray-500">{tender.label}</dt>
              <dd className="font-semibold text-gray-800">{formatMoney(tender.amount)}</dd>
            </div>
          ))}
          <div className="col-span-2 mt-1 flex items-center justify-between border-t border-green-100 pt-1.5">
            <dt className="font-medium text-gray-600">Total sales</dt>
            <dd className="font-bold text-gray-800">{formatMoney(shift.totalSales)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-green-100 pt-3">
        <Link href="/billing" className="flex items-center gap-1 text-xs font-bold text-[#8B5CF6] hover:text-[#7C3AED]">
          Go to Billing <ArrowRight size={12} />
        </Link>
        <Link href="/shifts" className="text-xs font-semibold text-gray-500 hover:text-gray-800">Manage shift</Link>
      </div>
    </Card>
  );
}

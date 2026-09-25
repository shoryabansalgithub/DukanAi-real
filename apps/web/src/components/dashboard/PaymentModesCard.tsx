'use client';

import React from 'react';
import { Card } from '@/components/ui/Card';
import { formatMoney, labelFor, PAYMENT_MODE_LABELS } from '@/components/customers/format';
import { CardSkeletonRows, CardUnavailable } from './CardStates';

interface PaymentModesCardProps {
  paymentModes: Array<{ mode: string; amount: number }>;
  loading?: boolean;
  unavailable?: boolean;
  onRetry?: () => void;
  className?: string;
}

/** Today's takings by tender (plus udhar), net of refunds, from `GET /dashboard/summary`. */
export function PaymentModesCard({ paymentModes, loading = false, unavailable = false, onRetry, className = '' }: PaymentModesCardProps) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-bold text-gray-800">Payment modes today</h3>
        <span className="text-[10px] font-medium text-gray-400">Net of refunds</span>
      </div>
      {loading ? (
        <CardSkeletonRows rows={3} />
      ) : unavailable ? (
        <CardUnavailable message="Today's payment modes could not be loaded." onRetry={onRetry} />
      ) : (
        <div className="space-y-2 text-sm text-gray-600">
          {paymentModes.map((payment) => (
            <div key={payment.mode} className="flex justify-between">
              <span>{labelFor(PAYMENT_MODE_LABELS, payment.mode)}</span>
              <span className={`font-semibold ${payment.amount < 0 ? 'text-red-500' : 'text-gray-800'}`}>{formatMoney(payment.amount)}</span>
            </div>
          ))}
          {paymentModes.length === 0 && <p className="py-2 text-center text-xs text-gray-500">No payments taken yet today.</p>}
        </div>
      )}
    </Card>
  );
}

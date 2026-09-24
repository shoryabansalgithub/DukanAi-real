'use client';

import React from 'react';
import { Card } from '@/components/ui/Card';
import { formatMoney, labelFor, PAYMENT_MODE_LABELS } from '@/components/customers/format';

interface PaymentModesCardProps {
  paymentModes: Array<{ mode: string; amount: number }>;
  className?: string;
}

/** Today's collections by tender (plus udhar) from `GET /dashboard/summary`. */
export function PaymentModesCard({ paymentModes, className = '' }: PaymentModesCardProps) {
  return (
    <Card className={`p-5 ${className}`}>
      <h3 className="mb-4 text-[15px] font-bold text-gray-800">Payment modes today</h3>
      <div className="space-y-2 text-sm text-gray-600">
        {paymentModes.map((payment) => (
          <div key={payment.mode} className="flex justify-between">
            <span>{labelFor(PAYMENT_MODE_LABELS, payment.mode)}</span>
            <span className="font-semibold text-gray-800">{formatMoney(payment.amount)}</span>
          </div>
        ))}
        {paymentModes.length === 0 && <p className="py-2 text-center text-xs text-gray-500">No payments taken yet today.</p>}
      </div>
    </Card>
  );
}

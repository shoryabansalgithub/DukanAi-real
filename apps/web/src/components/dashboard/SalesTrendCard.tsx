'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis,
} from 'recharts';
import { Card } from '@/components/ui/Card';
import { SkeletonBox } from '@/components/ui/Skeleton';
import type { TrendPoint } from '@/lib/api-client';
import { ErrorState } from '@/components/customers/States';

export const TREND_RANGES: Array<{ label: string; days: number }> = [
  { label: 'Today', days: 1 },
  { label: 'This Week', days: 7 },
  { label: 'This Month', days: 30 },
  { label: 'This Year', days: 365 },
];

interface SalesTrendCardProps {
  trend: TrendPoint[] | null;
  loading: boolean;
  error: string | null;
  days: number;
  onDaysChange: (days: number) => void;
  onRetry: () => void;
  className?: string;
}

/** `GET /dashboard/trends?days` as an area chart with the existing range picker. */
export function SalesTrendCard({ trend, loading, error, days, onDaysChange, onRetry, className = '' }: SalesTrendCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const current = TREND_RANGES.find((range) => range.days === days) ?? TREND_RANGES[1];

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);

  const hasData = !!trend && trend.some((point) => point.sales > 0);

  return (
    <Card className={`relative p-5 ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-bold text-gray-800">Sales Overview</h3>
        <div ref={dropdownRef} className="relative z-20">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((open) => !open)}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100"
          >
            {current.label} <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence>
            {isOpen && (
              <motion.div
                role="listbox"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute right-0 top-full z-50 mt-1 w-32 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-xl"
              >
                {TREND_RANGES.map((range) => (
                  <button
                    key={range.days}
                    type="button"
                    role="option"
                    aria-selected={range.days === days}
                    onClick={() => {
                      onDaysChange(range.days);
                      setIsOpen(false);
                    }}
                    className={`w-full px-4 py-2 text-left text-xs transition-colors hover:bg-purple-50 ${range.days === days ? 'bg-purple-50/50 font-bold text-[#8B5CF6]' : 'text-gray-600'}`}
                  >
                    {range.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {loading && !trend ? (
        <SkeletonBox className="mt-2 h-[190px] w-full rounded-lg" />
      ) : error && !trend ? (
        <div className="mt-2">
          <ErrorState compact title="Trend unavailable" message={error} onRetry={onRetry} retrying={loading} />
        </div>
      ) : hasData ? (
        <div className="mt-2 h-[190px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend ?? []} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="dashboardTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} dy={6} minTickGap={24} />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: '#64748b' }}
                tickFormatter={(val: number) => `₹${val >= 1000 ? `${Math.round(val / 100) / 10}k` : val}`}
              />
              <RechartsTooltip formatter={(value: number) => [`₹${Number(value).toLocaleString('en-IN')}`, 'Sales']} />
              <Area type="monotone" dataKey="sales" name="Sales" stroke="#8B5CF6" strokeWidth={2.5} fillOpacity={1} fill="url(#dashboardTrendFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-4 flex h-[180px] items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 px-6 text-center text-sm text-gray-500">
          Sales trend data will appear once invoices are recorded for the selected period.
        </div>
      )}
    </Card>
  );
}

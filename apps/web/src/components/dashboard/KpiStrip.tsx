'use client';

import React from 'react';
import { Activity } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SkeletonBox } from '@/components/ui/Skeleton';
import type { DashboardKpis } from '@/lib/api-client';
import { ErrorState } from '@/components/customers/States';
import { formatCount, formatMoney } from '@/components/customers/format';
import { StaleBadge } from './CardStates';

interface KpiStripProps {
  kpis: DashboardKpis | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}

/** Today's live KPIs from `GET /dashboard/kpis` (cached server-side for 60 s). */
export function KpiStrip({ kpis, loading, error, onRetry, className = '' }: KpiStripProps) {
  const rows = kpis
    ? [
        { label: 'Gross revenue', value: formatMoney(kpis.grossRevenue) },
        { label: 'Refunds', value: `-${formatMoney(kpis.totalRefunds)}`, tone: 'text-red-500' },
        { label: 'Net revenue', value: formatMoney(kpis.netRevenue), tone: 'text-gray-900', strong: true },
        { label: 'Orders', value: formatCount(kpis.orders) },
        { label: 'Avg order value (net)', value: formatMoney(kpis.avgOrderValue) },
      ]
    : [];

  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
          <Activity size={16} className="text-[#8B5CF6]" /> Today's KPIs
        </h3>
        {error && kpis ? (
          <StaleBadge detail={error} />
        ) : (
          kpis?.businessDate && <span className="text-[10px] font-medium text-gray-400">{kpis.businessDate}</span>
        )}
      </div>

      {loading && !kpis ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBox key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : error && !kpis ? (
        <ErrorState compact title="KPIs unavailable" message={error} onRetry={onRetry} retrying={loading} />
      ) : (
        <dl className="space-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className={`flex items-center justify-between ${row.strong ? 'border-t border-gray-100 pt-2' : ''}`}>
              <dt className="text-gray-600">{row.label}</dt>
              <dd className={`font-semibold ${row.tone ?? 'text-gray-800'}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Database, FileText, Package, RefreshCw, ShoppingBag, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { analyticsApi, type DashboardKpis, type DashboardSummary, type TrendPoint } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { SummaryStatCard } from '@/components/dashboard/SummaryStatCard';
import { ShiftCard } from '@/components/dashboard/ShiftCard';
import { RecentInvoicesCard } from '@/components/dashboard/RecentInvoicesCard';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { SalesTrendCard } from '@/components/dashboard/SalesTrendCard';
import { PaymentModesCard } from '@/components/dashboard/PaymentModesCard';
import { QuickActionsCard } from '@/components/dashboard/QuickActionsCard';
import { useVisibilityPolling } from '@/components/dashboard/useVisibilityPolling';
import { ErrorState } from '@/components/customers/States';
import { formatCount, formatMoney, formatTime } from '@/components/customers/format';

const POLL_INTERVAL_MS = 30 * 1000;

interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T,>(): Resource<T> => ({ data: null, loading: true, error: null });

export default function DashboardPage() {
  const [summary, setSummary] = useState<Resource<DashboardSummary>>(idle<DashboardSummary>());
  const [kpis, setKpis] = useState<Resource<DashboardKpis>>(idle<DashboardKpis>());
  const [trend, setTrend] = useState<Resource<TrendPoint[]>>(idle<TrendPoint[]>());
  const [trendDays, setTrendDays] = useState(7);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const trendSeq = useRef(0);

  const loadSummary = useCallback(async () => {
    setSummary((current) => ({ ...current, loading: true }));
    try {
      const data = await analyticsApi.dashboardSummary();
      setSummary({ data, loading: false, error: null });
      setLastUpdated(new Date());
    } catch (err) {
      setSummary((current) => ({
        ...current,
        loading: false,
        error: describeApiError(err, 'Loading dashboard summary (GET /dashboard/summary)'),
      }));
    }
  }, []);

  const loadKpis = useCallback(async () => {
    setKpis((current) => ({ ...current, loading: true }));
    try {
      const data = await analyticsApi.kpis();
      setKpis({ data, loading: false, error: null });
    } catch (err) {
      setKpis((current) => ({
        ...current,
        loading: false,
        error: describeApiError(err, 'Loading KPIs (GET /dashboard/kpis)'),
      }));
    }
  }, []);

  const loadTrend = useCallback(async (days: number) => {
    const seq = ++trendSeq.current;
    setTrend((current) => ({ ...current, loading: true }));
    try {
      const data = await analyticsApi.revenueTrend(days);
      if (seq !== trendSeq.current) return;
      setTrend({ data, loading: false, error: null });
    } catch (err) {
      if (seq !== trendSeq.current) return;
      setTrend((current) => ({
        ...current,
        loading: false,
        error: describeApiError(err, 'Loading sales trend (GET /dashboard/trends)'),
      }));
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadSummary();
    void loadKpis();
    void loadTrend(trendDays);
  }, [loadSummary, loadKpis, loadTrend, trendDays]);

  // Initial load of the two date-independent resources.
  useEffect(() => {
    void loadSummary();
    void loadKpis();
  }, [loadSummary, loadKpis]);

  // Trend reloads whenever the range changes (and on the shared poll).
  useEffect(() => {
    setTrend((current) => ({ ...current, data: null }));
    void loadTrend(trendDays);
  }, [trendDays, loadTrend]);

  // 30 s polling, paused while the tab is hidden.
  useVisibilityPolling(refreshAll, POLL_INTERVAL_MS);

  const s = summary.data;
  const initialLoading = summary.loading && !s;
  const refreshing = summary.loading || kpis.loading || trend.loading;

  if (summary.error && !s) {
    return (
      <div className="space-y-6">
        <ErrorState title="Unable to load the dashboard" message={summary.error} onRetry={() => void loadSummary()} retrying={summary.loading} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            {s ? (
              <>Business day <span className="font-semibold text-gray-700">{s.businessDate}</span> · {s.timezone}</>
            ) : (
              'Loading business day…'
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {summary.error && s && (
            <span className="rounded-full bg-red-50 px-2 py-1 font-semibold text-red-600" title={summary.error}>Refresh failed — showing last data</span>
          )}
          {lastUpdated && <span>Updated {formatTime(lastUpdated.toISOString())}</span>}
          <button
            type="button"
            onClick={refreshAll}
            disabled={refreshing}
            aria-label="Refresh dashboard"
            className="rounded-lg border border-gray-200 bg-white p-2 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Today */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryStatCard
          icon={<TrendingUp size={24} />}
          tone="bg-[#8B5CF6]/10 text-[#8B5CF6]"
          label="Today's sales (net)"
          value={s ? formatMoney(s.todaySales) : ''}
          hint={s ? `Gross ${formatMoney(s.todayGrossSales)} · Returns ${formatMoney(s.todayReturns)}` : undefined}
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<ShoppingBag size={24} />}
          tone="bg-green-500/10 text-green-500"
          label="Today's profit"
          value={s ? formatMoney(s.todayProfit) : ''}
          hint="Net profit today"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<FileText size={24} />}
          tone="bg-blue-500/10 text-blue-500"
          label="Today's orders"
          value={s ? formatCount(s.todayOrders) : ''}
          hint={s ? `${formatCount(s.todayReturnCount)} return${s.todayReturnCount === 1 ? '' : 's'}` : undefined}
          href="/invoices"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<Users size={24} />}
          tone="bg-orange-500/10 text-orange-500"
          label="Outstanding udhar"
          value={s ? formatMoney(s.outstandingUdhar) : ''}
          hint="Across all customers"
          href="/customers"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<Package size={24} />}
          tone="bg-amber-500/10 text-amber-500"
          label="Low & out of stock"
          value={
            s ? (
              <>
                {formatCount(s.lowStockCount)} <span className="text-sm text-red-500">/ {formatCount(s.outOfStockCount)}</span>
              </>
            ) : ''
          }
          hint="Low / out of stock"
          href="/inventory?tab=low-stock"
          loading={initialLoading}
        />
      </div>

      {/* All time */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryStatCard
          icon={<Wallet size={24} />}
          tone="bg-emerald-500/10 text-emerald-500"
          label="Total revenue"
          value={s ? formatMoney(s.totalRevenue) : ''}
          hint="Net, all time"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<FileText size={24} />}
          tone="bg-indigo-500/10 text-indigo-500"
          label="Total invoices"
          value={s ? formatCount(s.totalOrders) : ''}
          hint="All time"
          href="/invoices"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<Users size={24} />}
          tone="bg-teal-500/10 text-teal-500"
          label="Total customers"
          value={s ? formatCount(s.totalCustomers) : ''}
          hint="Registered"
          href="/customers"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<Package size={24} />}
          tone="bg-rose-500/10 text-rose-500"
          label="Total products"
          value={s ? formatCount(s.totalProducts) : ''}
          hint="Catalog size"
          href="/products"
          loading={initialLoading}
        />
        <SummaryStatCard
          icon={<Database size={24} />}
          tone="bg-cyan-500/10 text-cyan-500"
          label="Inventory value"
          value={s ? formatMoney(s.inventoryValue) : ''}
          hint="Current stock worth"
          href="/inventory"
          loading={initialLoading}
        />
      </div>

      {/* Trend + quick actions + shift */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <SalesTrendCard
          className="lg:col-span-6"
          trend={trend.data}
          loading={trend.loading}
          error={trend.error}
          days={trendDays}
          onDaysChange={setTrendDays}
          onRetry={() => void loadTrend(trendDays)}
        />
        <QuickActionsCard className="lg:col-span-3" />
        <ShiftCard className="lg:col-span-3" shift={s?.shift ?? null} />
      </div>

      {/* KPIs + payment modes + recent invoices */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <KpiStrip kpis={kpis.data} loading={kpis.loading} error={kpis.error} onRetry={() => void loadKpis()} />
        <PaymentModesCard paymentModes={s?.paymentModes ?? []} />
        <RecentInvoicesCard invoices={s?.recentInvoices ?? []} />
      </div>
    </div>
  );
}

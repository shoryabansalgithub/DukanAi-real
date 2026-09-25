'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Database, FileText, Package, RefreshCw, ShoppingBag, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { analyticsApi, type DashboardSummarySection } from '@/lib/api-client';
import { SummaryStatCard } from '@/components/dashboard/SummaryStatCard';
import { ShiftCard } from '@/components/dashboard/ShiftCard';
import { RecentInvoicesCard } from '@/components/dashboard/RecentInvoicesCard';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { SalesTrendCard } from '@/components/dashboard/SalesTrendCard';
import { PaymentModesCard } from '@/components/dashboard/PaymentModesCard';
import { QuickActionsCard } from '@/components/dashboard/QuickActionsCard';
import { LowStockCard } from '@/components/dashboard/LowStockCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { StaleBadge } from '@/components/dashboard/CardStates';
import { useVisibilityPolling } from '@/components/dashboard/useVisibilityPolling';
import { useDashboardResource } from '@/components/dashboard/useDashboardResource';
import { ErrorState } from '@/components/customers/States';
import { formatCount, formatMoney, formatTime } from '@/components/customers/format';

const POLL_INTERVAL_MS = 30 * 1000;

const money = (value: number | null | undefined) => (value === null || value === undefined ? '' : formatMoney(value));
const count = (value: number | null | undefined) => (value === null || value === undefined ? '' : formatCount(value));

export default function DashboardPage() {
  const [trendDays, setTrendDays] = useState(7);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchSummary = useCallback(() => analyticsApi.dashboardSummary(), []);
  const fetchKpis = useCallback(() => analyticsApi.kpis(), []);
  const fetchTrend = useCallback(() => analyticsApi.revenueTrend(trendDays), [trendDays]);
  const fetchInsights = useCallback(() => analyticsApi.insights(), []);

  const [summary, loadSummary] = useDashboardResource(fetchSummary, 'Loading dashboard summary (GET /dashboard/summary)');
  const [kpis, loadKpis] = useDashboardResource(fetchKpis, 'Loading KPIs (GET /dashboard/kpis)');
  const [trend, loadTrend] = useDashboardResource(fetchTrend, 'Loading sales trend (GET /dashboard/trends)');
  const [insights, loadInsights] = useDashboardResource(fetchInsights, 'Loading AI insights (GET /dashboard/insights)');

  const refreshSummary = useCallback(
    async (force = false) => {
      if (await loadSummary({ force })) setLastUpdated(new Date());
    },
    [loadSummary],
  );

  /** Poll tick (skips resources still loading) or manual refresh (`force`). */
  const refreshAll = useCallback(
    (force = false) => {
      void refreshSummary(force);
      void loadKpis({ force });
      void loadTrend({ force });
      void loadInsights({ force });
    },
    [refreshSummary, loadKpis, loadTrend, loadInsights],
  );

  // Initial load of the date-independent resources.
  useEffect(() => {
    void refreshSummary();
    void loadKpis();
    void loadInsights();
  }, [refreshSummary, loadKpis, loadInsights]);

  // Trend reloads whenever the range changes; the previous range's data and
  // any in-flight response for it no longer apply.
  useEffect(() => {
    void loadTrend({ force: true, reset: true });
  }, [loadTrend]);

  // 30 s polling, paused while the tab is hidden, never overlapping a request in flight.
  const poll = useCallback(() => refreshAll(false), [refreshAll]);
  useVisibilityPolling(poll, POLL_INTERVAL_MS);

  const s = summary.data;
  const summaryLoading = summary.loading && !s;
  const summaryDown = !!summary.error && !s;
  const failed = new Set<DashboardSummarySection>(s?.failedSections ?? []);
  const tile = (section: DashboardSummarySection) => ({ loading: summaryLoading, unavailable: summaryDown || failed.has(section) });
  const card = (section: DashboardSummarySection) => ({
    loading: summaryLoading,
    unavailable: summaryDown || failed.has(section),
    onRetry: () => void refreshSummary(true),
  });
  const refreshing = summary.loading || kpis.loading || trend.loading || insights.loading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            {s ? (
              <>Business day <span className="font-semibold text-gray-700">{s.businessDate}</span> · {s.timezone}</>
            ) : summaryDown ? (
              'Business day unavailable'
            ) : (
              'Loading business day…'
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {summary.error && s && <StaleBadge detail={summary.error} />}
          {s && failed.size > 0 && !summary.error && (
            <span role="status" className="rounded-full bg-amber-50 px-2 py-1 font-semibold text-amber-700">
              Some figures are unavailable
            </span>
          )}
          {lastUpdated && <span>Updated {formatTime(lastUpdated.toISOString())}</span>}
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={refreshing}
            aria-label="Refresh dashboard"
            className="rounded-lg border border-gray-200 bg-white p-2 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {summaryDown && (
        <ErrorState
          compact
          title="Today's figures are unavailable"
          message={summary.error!}
          onRetry={() => void refreshSummary(true)}
          retrying={summary.loading}
        />
      )}

      {/* Today */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryStatCard
          icon={<TrendingUp size={24} />}
          tone="bg-[#8B5CF6]/10 text-[#8B5CF6]"
          label="Today's sales (net)"
          value={money(s?.todaySales)}
          hint={s && s.todayGrossSales !== null ? `Gross ${formatMoney(s.todayGrossSales)} · Returns ${formatMoney(s.todayReturns ?? 0)}` : undefined}
          {...tile('today')}
        />
        <SummaryStatCard
          icon={<ShoppingBag size={24} />}
          tone="bg-green-500/10 text-green-500"
          label="Today's gross profit"
          value={money(s?.todayProfit)}
          hint="Sales − cost of goods, after returns"
          {...tile('todayProfit')}
        />
        <SummaryStatCard
          icon={<FileText size={24} />}
          tone="bg-blue-500/10 text-blue-500"
          label="Today's orders"
          value={count(s?.todayOrders)}
          hint={s && s.todayReturnCount !== null ? `${formatCount(s.todayReturnCount)} return${s.todayReturnCount === 1 ? '' : 's'}` : undefined}
          href="/invoices"
          {...tile('today')}
        />
        <SummaryStatCard
          icon={<Users size={24} />}
          tone="bg-orange-500/10 text-orange-500"
          label="Outstanding udhar"
          value={money(s?.outstandingUdhar)}
          hint="Across all customers"
          href="/customers"
          {...tile('udhar')}
        />
        <SummaryStatCard
          icon={<Package size={24} />}
          tone="bg-amber-500/10 text-amber-500"
          label="Low & out of stock"
          value={
            s && s.lowStockCount !== null && s.outOfStockCount !== null ? (
              <>
                {formatCount(s.lowStockCount)} <span className="text-sm text-red-500">/ {formatCount(s.outOfStockCount)}</span>
              </>
            ) : ''
          }
          hint="Low / out of stock"
          href="/inventory?tab=low-stock"
          {...tile('stock')}
        />
      </div>

      {/* All time */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryStatCard
          icon={<Wallet size={24} />}
          tone="bg-emerald-500/10 text-emerald-500"
          label="Total revenue"
          value={money(s?.totalRevenue)}
          hint="Net, all time"
          {...tile('allTime')}
        />
        <SummaryStatCard
          icon={<FileText size={24} />}
          tone="bg-indigo-500/10 text-indigo-500"
          label="Total invoices"
          value={count(s?.totalOrders)}
          hint="Sales, all time"
          href="/invoices"
          {...tile('allTime')}
        />
        <SummaryStatCard
          icon={<Users size={24} />}
          tone="bg-teal-500/10 text-teal-500"
          label="Total customers"
          value={count(s?.totalCustomers)}
          hint="Registered"
          href="/customers"
          {...tile('customers')}
        />
        <SummaryStatCard
          icon={<Package size={24} />}
          tone="bg-rose-500/10 text-rose-500"
          label="Total products"
          value={count(s?.totalProducts)}
          hint="Catalog size"
          href="/products"
          {...tile('products')}
        />
        <SummaryStatCard
          icon={<Database size={24} />}
          tone="bg-cyan-500/10 text-cyan-500"
          label="Inventory value"
          value={money(s?.inventoryValue)}
          hint="Current stock at cost"
          href="/inventory"
          {...tile('inventoryValue')}
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
          onRetry={() => void loadTrend({ force: true })}
        />
        <QuickActionsCard className="lg:col-span-3" />
        <ShiftCard className="lg:col-span-3" shift={s?.shift ?? null} {...card('shift')} />
      </div>

      {/* AI insights + low stock */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <AiInsightsCard
          className="lg:col-span-2"
          insights={insights.data}
          loading={insights.loading}
          error={insights.error}
          onRetry={() => void loadInsights({ force: true })}
        />
        <LowStockCard
          items={s?.lowStockItems ?? []}
          lowStockCount={s?.lowStockCount ?? null}
          outOfStockCount={s?.outOfStockCount ?? null}
          {...card('stock')}
        />
      </div>

      {/* KPIs + payment modes + recent invoices */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <KpiStrip kpis={kpis.data} loading={kpis.loading} error={kpis.error} onRetry={() => void loadKpis({ force: true })} />
        <PaymentModesCard paymentModes={s?.paymentModes ?? []} {...card('paymentModes')} />
        <RecentInvoicesCard
          invoices={s?.recentInvoices ?? []}
          businessDate={s?.businessDate}
          timezone={s?.timezone}
          {...card('recentInvoices')}
        />
      </div>
    </div>
  );
}

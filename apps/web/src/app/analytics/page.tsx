'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import {
  TrendingUp, TrendingDown, Users, Package, Wallet, Download, Calendar, BarChart3,
  PieChart as PieChartIcon, Activity, ChevronDown, FileText, Receipt, Table,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';
import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from '@/components/ui/Toast';
import { SkeletonBox } from '@/components/ui/Skeleton';
import {
  analyticsApi,
  type AnalyticsPagePayload,
  type AnalyticsRange,
  type DashboardSummary,
  type ExportKind,
} from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { ErrorState } from '@/components/customers/States';
import { formatDate, formatMoney, labelFor, PAYMENT_MODE_LABELS, toIsoDate } from '@/components/customers/format';

const RANGE_OPTIONS: Array<{ label: string; value: AnalyticsRange; days: number }> = [
  { label: 'Today', value: 'today', days: 1 },
  { label: 'This Week', value: 'week', days: 7 },
  { label: 'This Month', value: 'month', days: 30 },
  { label: 'This Year', value: 'year', days: 365 },
];

const EXPORTS: Array<{ kind: ExportKind; label: string; description: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }> = [
  { kind: 'invoices', label: 'Invoices', description: 'One row per invoice', icon: Receipt },
  { kind: 'invoice-items', label: 'Invoice items', description: 'One row per line item', icon: Table },
  { kind: 'gst-summary', label: 'GST summary', description: 'Taxable value and tax by rate', icon: FileText },
];

const CHART_COLORS = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#14B8A6'];

/** The analytics API treats ranges as rolling windows of N days ending today. */
function rangeDates(range: AnalyticsRange): { from: string; to: string } {
  const days = RANGE_OPTIONS.find((option) => option.value === range)?.days ?? 7;
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - (days - 1));
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

function ChangeBadge({ pct, invert = false }: { pct: number | null; invert?: boolean }) {
  if (pct === null) {
    return <span className="text-gray-400 font-medium">No prior-period data</span>;
  }
  const positive = pct >= 0;
  const good = invert ? !positive : positive;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <>
      <Icon size={14} className={good ? 'text-green-600' : 'text-red-600'} />
      <span className={good ? 'text-green-600' : 'text-red-600'}>
        {positive ? '+' : ''}{pct}%
      </span>
      <span className="text-gray-400 font-medium ml-1">vs previous period</span>
    </>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBox key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SkeletonBox className="h-[360px] w-full rounded-xl lg:col-span-2" />
        <SkeletonBox className="h-[360px] w-full rounded-xl" />
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { toast } = useToast();
  const [range, setRange] = useState<AnalyticsRange>('week');
  const [data, setData] = useState<AnalyticsPagePayload | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [pageData, summaryData] = await Promise.all([
        analyticsApi.analyticsPage(range),
        analyticsApi.dashboardSummary(),
      ]);
      if (seq !== requestSeq.current) return;
      setData(pageData);
      setSummary(summaryData);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(describeApiError(err, 'Loading analytics (GET /dashboard/analytics, GET /dashboard/summary)'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isExportOpen) return;
    const close = (event: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) setIsExportOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isExportOpen]);

  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? 'This Week';
  const exportDates = rangeDates(range);

  const handleExport = async (kind: ExportKind) => {
    if (exporting) return;
    setExporting(kind);
    try {
      await analyticsApi.exportCsv(kind, exportDates.from, exportDates.to);
      toast(`${EXPORTS.find((e) => e.kind === kind)?.label ?? 'CSV'} export downloaded`, 'success');
      setIsExportOpen(false);
    } catch (err) {
      toast(describeApiError(err, `Exporting ${kind} CSV (GET /dashboard/export/${kind}.csv)`), 'error');
    } finally {
      setExporting(null);
    }
  };

  // Custom Tooltip for Recharts
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-900 border border-gray-700 text-white p-3 rounded-xl shadow-xl">
          <p className="font-bold text-sm mb-1">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-xs flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }}></span>
              {entry.name}: <span className="font-bold">₹{Number(entry.value).toLocaleString('en-IN')}</span>
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const paymentModes = (data?.paymentModes ?? []).map((mode, i) => ({
    ...mode,
    name: labelFor(PAYMENT_MODE_LABELS, mode.name),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  const categorySales = (data?.categorySales ?? []).map((category, i) => ({
    ...category,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Reports & Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">Data-driven insights to grow your retail business.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <select
              value={range}
              aria-label="Report range"
              onChange={(e) => setRange(e.target.value as AnalyticsRange)}
              className="appearance-none bg-white border border-gray-200 text-gray-700 py-2.5 pl-4 pr-10 rounded-xl text-sm font-bold shadow-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20"
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={16} />
          </div>

          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setIsExportOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={isExportOpen}
              disabled={exporting !== null}
              className="bg-[#060B26] hover:bg-gray-900 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg transition-all disabled:opacity-60"
            >
              <Download size={18} />
              {exporting ? 'Exporting…' : 'Export'}
              <ChevronDown size={14} className={`transition-transform ${isExportOpen ? 'rotate-180' : ''}`} />
            </button>
            <AnimatePresence>
              {isExportOpen && (
                <motion.div
                  role="menu"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-2xl"
                >
                  <div className="border-b border-gray-100 bg-gray-50/60 px-4 py-2.5 text-[11px] text-gray-500">
                    CSV for <span className="font-bold text-gray-700">{rangeLabel}</span>: {formatDate(exportDates.from)} – {formatDate(exportDates.to)}
                  </div>
                  {EXPORTS.map((item) => {
                    const Icon = item.icon;
                    const busy = exporting === item.kind;
                    return (
                      <button
                        key={item.kind}
                        role="menuitem"
                        type="button"
                        onClick={() => void handleExport(item.kind)}
                        disabled={exporting !== null}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-[#8B5CF6]">
                          <Icon size={16} />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-bold text-gray-800">{item.label}</p>
                          <p className="text-[11px] text-gray-500">{item.description}</p>
                        </div>
                        {busy && <span className="text-[10px] font-bold text-[#8B5CF6]">Downloading…</span>}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {loading && !data && <AnalyticsSkeleton />}

      {!loading && loadError && (
        <ErrorState title="Unable to load analytics" message={loadError} onRetry={() => void load()} retrying={loading} />
      )}

      {!loadError && data && (
        <>
          {loading && <p className="text-xs font-medium text-gray-400">Refreshing for {rangeLabel}…</p>}

          {/* Top Overview KPIs */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="p-5 flex flex-col justify-between hoverable group overflow-hidden relative">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-green-500/10 rounded-full group-hover:scale-150 transition-transform duration-500" />
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Total Revenue</p>
                  <h3 className="text-2xl font-black text-gray-800 mt-1">{formatMoney(data.kpis.totalRevenue)}</h3>
                </div>
                <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center text-green-600">
                  <TrendingUp size={20} />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold relative z-10">
                <ChangeBadge pct={data.kpis.revenueChangePct} />
              </div>
            </Card>

            <Card className="p-5 flex flex-col justify-between hoverable group overflow-hidden relative">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-purple-500/10 rounded-full group-hover:scale-150 transition-transform duration-500" />
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Net Profit</p>
                  <h3 className="text-2xl font-black text-gray-800 mt-1">{formatMoney(data.kpis.netProfit)}</h3>
                </div>
                <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center text-[#8B5CF6]">
                  <Wallet size={20} />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold relative z-10">
                <ChangeBadge pct={data.kpis.profitChangePct} />
              </div>
            </Card>

            <Card className="p-5 flex flex-col justify-between hoverable group overflow-hidden relative">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-orange-500/10 rounded-full group-hover:scale-150 transition-transform duration-500" />
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Udhar Outstanding</p>
                  <h3 className="text-2xl font-black text-gray-800 mt-1">{formatMoney(data.kpis.udharOutstanding)}</h3>
                </div>
                <div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center text-orange-600">
                  <Users size={20} />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold text-orange-600 relative z-10">
                <span>Across all customers</span>
              </div>
            </Card>

            <Card className="p-5 flex flex-col justify-between hoverable group overflow-hidden relative">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-blue-500/10 rounded-full group-hover:scale-150 transition-transform duration-500" />
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Avg Order Value</p>
                  <h3 className="text-2xl font-black text-gray-800 mt-1">{formatMoney(data.kpis.avgOrderValue)}</h3>
                </div>
                <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
                  <Package size={20} />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold relative z-10">
                <ChangeBadge pct={data.kpis.aovChangePct} />
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Sales Area Chart */}
            <Card className="lg:col-span-2 p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
              <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <Activity size={18} className="text-[#8B5CF6]" />
                  Revenue Trend ({rangeLabel})
                </h3>
              </div>
              <div className="h-[300px] w-full">
                {data.revenueTrend.some((point) => point.sales > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.revenueTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} dy={10} minTickGap={24} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={(val) => `₹${val >= 1000 ? `${Math.round(val / 100) / 10}k` : val}`} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Area type="monotone" dataKey="sales" name="Sales" stroke="#8B5CF6" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500">
                    No completed invoices in this period yet.
                  </div>
                )}
              </div>
            </Card>

            {/* Payment Modes Pie Chart */}
            <Card className="p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
              <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <PieChartIcon size={18} className="text-blue-500" />
                  Payment Methods
                </h3>
              </div>
              {paymentModes.length > 0 ? (
                <>
                  <div className="h-[250px] w-full flex justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={paymentModes}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={90}
                          paddingAngle={5}
                          dataKey="value"
                          stroke="none"
                        >
                          {paymentModes.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip formatter={(value: number, name: string) => [`${value}%`, name]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="grid grid-cols-2 gap-y-3 mt-4">
                    {paymentModes.map((mode, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs font-bold text-gray-700">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: mode.color }}></span>
                        {mode.name} <span className="text-gray-400 font-medium ml-auto">{mode.value}%</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[250px] flex items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500 text-center px-6">
                  Payment split appears after the first completed invoice.
                </div>
              )}
            </Card>

            {/* Top Categories Bar Chart */}
            <Card className="lg:col-span-2 p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
              <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <BarChart3 size={18} className="text-orange-500" />
                  Top Selling Categories
                </h3>
              </div>
              <div className="h-[300px] w-full">
                {categorySales.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={categorySales} layout="vertical" margin={{ top: 0, right: 30, left: 20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                      <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                      <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#334155', fontWeight: 600 }} width={100} />
                      <RechartsTooltip formatter={(value: number, _name: string, item: any) => [`${value}% (₹${Number(item?.payload?.amount ?? 0).toLocaleString('en-IN')})`, 'Share']} cursor={{fill: '#f8fafc'}} />
                      <Bar dataKey="value" name="Sales (%)" radius={[0, 4, 4, 0]} barSize={24}>
                        {categorySales.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500">
                    Category sales appear after the first completed invoice.
                  </div>
                )}
              </div>
            </Card>

            {/* Customer Insights */}
            <Card className="p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
              <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <Users size={18} className="text-green-500" />
                  Top Loyal Customers
                </h3>
              </div>
              {data.topCustomers.length > 0 ? (
                <div className="space-y-4">
                  {data.topCustomers.map((cust, i) => (
                    <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs">
                          {cust.name.substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-gray-800 leading-tight">{cust.name}</p>
                          <p className="text-[10px] text-gray-500">{cust.frequency} purchase{cust.frequency === 1 ? '' : 's'} in period</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-black text-gray-800">{formatMoney(cust.spent)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
                  Customer insights appear once invoices are billed to named customers.
                </div>
              )}
              <Link href="/customers" className="block w-full mt-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold text-[#8B5CF6] hover:bg-purple-50 transition-colors text-center">
                View All Customers
              </Link>
            </Card>
          </div>

          {/* Recent Transactions Table */}
          <Card className="p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)] mt-6">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">
                <Wallet size={18} className="text-[#8B5CF6]" />
                Recent Transactions
              </h3>
              <Link href="/invoices" className="text-xs font-bold text-[#8B5CF6] hover:underline">All invoices</Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="text-xs text-gray-400 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-3 font-medium">Invoice No</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Mode</th>
                    <th className="px-4 py-3 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.recentInvoices ?? []).map((invoice) => {
                    const isReturn = invoice.type === 'SALES_RETURN';
                    const isCancelled = invoice.status === 'CANCELLED';
                    return (
                      <tr key={invoice.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="px-4 py-3 font-semibold text-gray-800">
                          <Link href={`/invoices/${invoice.id}`} className="hover:text-[#8B5CF6] hover:underline">#{invoice.invoiceNumber}</Link>
                          {isReturn && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">Return</span>}
                          {isCancelled && <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Cancelled</span>}
                        </td>
                        <td className="px-4 py-3">{invoice.customer?.name ?? 'Walk-in'}</td>
                        <td className="px-4 py-3">{formatDate(invoice.createdAt)}</td>
                        <td className="px-4 py-3">
                          <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded text-[10px] font-bold">
                            {labelFor(PAYMENT_MODE_LABELS, invoice.paymentMode)}
                          </span>
                        </td>
                        <td className={`px-4 py-3 font-bold text-right ${isCancelled ? 'text-gray-400 line-through' : isReturn ? 'text-red-500' : 'text-gray-800'}`}>
                          {isReturn ? '-' : ''}{formatMoney(invoice.totalAmount)}
                        </td>
                      </tr>
                    );
                  })}
                  {summary && summary.recentInvoices.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        No transactions found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

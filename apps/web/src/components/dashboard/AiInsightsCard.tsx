'use client';

import React from 'react';
import Link from 'next/link';
import { Sparkles, TrendingUp, PackagePlus, Trophy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { DashboardInsights, RestockSuggestion } from '@/lib/api-client';
import { formatMoney } from '@/components/customers/format';
import { CardSkeletonRows, CardUnavailable, StaleBadge } from './CardStates';
import { formatStock } from './LowStockCard';

interface AiInsightsCardProps {
  insights: DashboardInsights | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}

const URGENCY_STYLE: Record<RestockSuggestion['urgency'], { label: string; className: string }> = {
  OUT_OF_STOCK: { label: 'Out of stock', className: 'bg-red-50 text-red-600' },
  CRITICAL: { label: 'Critical', className: 'bg-orange-50 text-orange-600' },
  LOW: { label: 'Low', className: 'bg-amber-50 text-amber-700' },
};

function SectionUnavailable({ what }: { what: string }) {
  return <p className="text-xs font-medium text-red-500">{what} is unavailable right now.</p>;
}

/**
 * The dashboard's AI insights from `GET /dashboard/insights`: today's sales
 * against the 7-day forecast, restock suggestions from sales velocity, and
 * the top earner. Loads and fails on its own; nothing else depends on it.
 */
export function AiInsightsCard({ insights, loading, error, onRetry, className = '' }: AiInsightsCardProps) {
  const failed = new Set(insights?.failedSections ?? []);
  const forecast = insights?.forecast ?? null;
  const restock = insights?.restock ?? null;
  const top = insights?.topProduct ?? null;

  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
          <Sparkles size={16} className="text-[#8B5CF6]" /> AI insights
        </h3>
        {error && insights ? <StaleBadge detail={error} /> : <span className="text-[10px] font-medium text-gray-400">From your sales history</span>}
      </div>

      {loading && !insights ? (
        <CardSkeletonRows rows={6} />
      ) : error && !insights ? (
        <CardUnavailable title="Insights unavailable" message={error} onRetry={onRetry} retrying={loading} />
      ) : insights ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {/* Forecast */}
          <section aria-label="Sales forecast" className="rounded-xl bg-purple-50/50 p-4">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-700">
              <TrendingUp size={14} className="text-[#8B5CF6]" /> Today&apos;s sales forecast
            </p>
            {failed.has('forecast') || !forecast ? (
              <div className="mt-2"><SectionUnavailable what="The forecast" /></div>
            ) : forecast.basisDays === 0 ? (
              <p className="mt-2 text-xs text-gray-500">Not enough sales history yet. A forecast appears after the first full day of sales.</p>
            ) : (
              <>
                <p className="mt-2 text-2xl font-bold tracking-tight text-gray-800">{formatMoney(forecast.forecastNetRevenue)}</p>
                <p className="text-[11px] text-gray-500">
                  {formatMoney(forecast.todayNetSales)} so far{forecast.progressPct !== null ? ` · ${forecast.progressPct}% of forecast` : ''}
                </p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-purple-100" aria-hidden="true">
                  <div className="h-full rounded-full bg-[#8B5CF6]" style={{ width: `${Math.max(0, Math.min(100, forecast.progressPct ?? 0))}%` }} />
                </div>
                <p className="mt-2 text-[10px] text-gray-400">
                  Average net sales of {forecast.basisDays} day{forecast.basisDays === 1 ? '' : 's'} ({forecast.basisFrom} to {forecast.basisTo})
                  {forecast.confidence === 'LOW' ? ' · low confidence' : ''}
                </p>
              </>
            )}
          </section>

          {/* Restock */}
          <section aria-label="Restock suggestions" className="md:col-span-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-700">
              <PackagePlus size={14} className="text-amber-500" /> Restock suggestions
            </p>
            {failed.has('restock') || !restock ? (
              <div className="mt-2"><SectionUnavailable what="Restock advice" /></div>
            ) : restock.items.length === 0 ? (
              <p className="mt-2 text-xs text-gray-500">No restock needed right now: every product covers its expected demand.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {restock.items.map((item) => {
                  const urgency = URGENCY_STYLE[item.urgency];
                  return (
                    <li key={item.productId} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-[12px] font-bold text-gray-800">
                          <span className="truncate">{item.name}</span>
                          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${urgency.className}`}>{urgency.label}</span>
                        </p>
                        <p className="truncate text-[10px] text-gray-500">{item.reason}</p>
                      </div>
                      <span className="shrink-0 text-right text-xs font-bold text-gray-800">
                        Order {formatStock(item.suggestedQuantity, item.unit)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {restock && !failed.has('restock') && (
              <p className="mt-2 text-[10px] text-gray-400">
                Based on net units sold over the last {restock.basisDays} days; refills to the reorder point plus {restock.coverDays} days of demand.
              </p>
            )}
          </section>

          {/* Top product */}
          <section aria-label="Top product" className="md:col-span-3 flex items-center justify-between gap-3 border-t border-gray-100 pt-3">
            <p className="flex items-center gap-1.5 text-xs font-bold text-gray-700">
              <Trophy size={14} className="text-emerald-500" /> Top earner, last 30 days
            </p>
            {failed.has('topProduct') ? (
              <SectionUnavailable what="The top product" />
            ) : top ? (
              <Link href="/analytics" className="min-w-0 truncate text-right text-xs text-gray-600 hover:text-gray-900">
                <span className="font-bold text-gray-800">{top.name}</span> · {formatMoney(top.grossProfit)} profit · {top.grossMarginPct}% margin
              </Link>
            ) : (
              <span className="text-xs text-gray-500">No profitable sales in the last 30 days yet.</span>
            )}
          </section>
        </div>
      ) : null}
    </Card>
  );
}

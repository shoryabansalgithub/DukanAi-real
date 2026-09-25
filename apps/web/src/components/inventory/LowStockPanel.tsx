'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PackageCheck, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { analyticsApi, type LowStockList } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/customers/States';
import { formatCount } from '@/components/customers/format';
import { formatStock } from '@/components/dashboard/LowStockCard';

const LOW_STOCK_LIMIT = 500;

/** Inventory "Low Stock" tab: every stock alert from `GET /dashboard/low-stock`, out of stock first. */
export function LowStockPanel() {
  const [data, setData] = useState<LowStockList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const result = await analyticsApi.lowStock(LOW_STOCK_LIMIT);
      if (id !== seq.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setError(describeApiError(err, 'Loading low stock (GET /dashboard/low-stock)'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = data?.items ?? [];
    return needle ? all.filter((item) => item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle)) : all;
  }, [data, query]);

  const total = data ? data.lowStockCount + data.outOfStockCount : 0;

  return (
    <Card className="p-0 overflow-visible">
      <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row gap-4 justify-between items-center bg-gray-50/50">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder="Search by product or SKU..."
            aria-label="Search low stock products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all"
          />
        </div>
        {data && (
          <p className="text-xs text-gray-500">
            <span className="font-bold text-amber-600">{formatCount(data.lowStockCount)} low</span>
            {' · '}
            <span className="font-bold text-red-600">{formatCount(data.outOfStockCount)} out of stock</span>
            {total > data.items.length ? ` · showing the ${formatCount(data.items.length)} most urgent` : ''}
          </p>
        )}
      </div>

      {loading && !data ? (
        <TableSkeleton rows={6} cols={5} />
      ) : error && !data ? (
        <div className="p-6">
          <ErrorState title="Low stock is unavailable" message={error} onRetry={() => void load()} retrying={loading} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<PackageCheck size={32} />}
          title={query ? 'No matching products' : 'Nothing to restock'}
          hint={query ? 'Try another name or SKU.' : 'Every active, stock-tracked product is above its reorder point.'}
        />
      ) : (
        <div className="overflow-x-auto">
          {error && (
            <p role="status" className="px-6 pt-4 text-xs font-semibold text-red-600" title={error}>Refresh failed — showing last data</p>
          )}
          <table className="w-full text-left text-sm text-gray-600">
            <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase font-semibold border-b border-gray-100">
              <tr>
                <th className="px-6 py-4">Product</th>
                <th className="px-6 py-4">SKU</th>
                <th className="px-6 py-4">In stock</th>
                <th className="px-6 py-4">Reorder point</th>
                <th className="px-6 py-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => {
                const out = item.status === 'OUT_OF_STOCK';
                return (
                  <tr key={item.productId} className="hover:bg-gray-50/60">
                    <td className="px-6 py-3 font-semibold text-gray-800">{item.name}</td>
                    <td className="px-6 py-3 text-xs text-gray-500">{item.sku}</td>
                    <td className={`px-6 py-3 font-bold ${out ? 'text-red-600' : 'text-amber-600'}`}>{formatStock(item.currentStock, item.unit)}</td>
                    <td className="px-6 py-3">{formatStock(item.reorderPoint, item.unit)}</td>
                    <td className="px-6 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${out ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                        {out ? 'Out of stock' : 'Low stock'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

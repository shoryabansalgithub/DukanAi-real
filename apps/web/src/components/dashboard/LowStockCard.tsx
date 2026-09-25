'use client';

import React from 'react';
import Link from 'next/link';
import { PackageX } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { LowStockItem } from '@/lib/api-client';
import { formatCount } from '@/components/customers/format';
import { CardSkeletonRows, CardUnavailable } from './CardStates';

interface LowStockCardProps {
  items: LowStockItem[];
  lowStockCount: number | null;
  outOfStockCount: number | null;
  loading?: boolean;
  unavailable?: boolean;
  onRetry?: () => void;
  className?: string;
}

export function formatStock(value: number, unit: string): string {
  const qty = value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${qty} ${unit.toLowerCase()}` : qty;
}

/** Most urgent stock alerts from `GET /dashboard/summary` (active, stock-tracked products only). */
export function LowStockCard({ items, lowStockCount, outOfStockCount, loading = false, unavailable = false, onRetry, className = '' }: LowStockCardProps) {
  const total = (lowStockCount ?? 0) + (outOfStockCount ?? 0);
  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-gray-800">
          <PackageX size={16} className="text-amber-500" /> Low stock
        </h3>
        <Link href="/inventory?tab=low-stock" className="text-xs font-semibold text-[#8B5CF6] hover:text-[#7C3AED]">
          View all{!loading && !unavailable && total > 0 ? ` (${formatCount(total)})` : ''}
        </Link>
      </div>
      {loading ? (
        <CardSkeletonRows rows={4} />
      ) : unavailable ? (
        <CardUnavailable message="Stock alerts could not be loaded." onRetry={onRetry} />
      ) : items.length === 0 ? (
        <p className="py-2 text-center text-xs text-gray-500">Every product is above its reorder point.</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => {
            const out = item.status === 'OUT_OF_STOCK';
            return (
              <li key={item.productId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-bold text-gray-800">{item.name}</p>
                  <p className="text-[10px] text-gray-400">
                    {item.sku} · Reorder at {formatStock(item.reorderPoint, item.unit)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`text-xs font-bold ${out ? 'text-red-500' : 'text-amber-600'}`}>{formatStock(item.currentStock, item.unit)}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${out ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                    {out ? 'Out' : 'Low'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

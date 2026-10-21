'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { SkeletonTable } from '@/components/ui/Skeleton';
import { shiftsApi } from '@/lib/api-client';
import type { Shift } from '@/types';
import { ShiftBanner } from '@/components/pos/ShiftBanner';
import { extractApiError } from '@/components/pos/api-errors';
import { dateTime, money, signedMoney } from '@/components/pos/format';

export default function ShiftsPage() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerRefresh, setBannerRefresh] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await shiftsApi.list({ take: 50 });
      setShifts(res.items);
    } catch (err) {
      setError(extractApiError(err, 'Loading shifts (GET /shifts)').message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload the list whenever the banner opens / closes a shift.
  const firstChange = React.useRef(true);
  const handleShiftChange = useCallback(() => {
    if (firstChange.current) {
      firstChange.current = false;
      return;
    }
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Shifts</h1>
          <p className="text-sm text-gray-500 mt-1">Cash drawer sessions: opening float, expected cash and variance at close.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setBannerRefresh((n) => n + 1);
            void load();
          }}
          className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <ShiftBanner onShiftChange={handleShiftChange} refreshToken={bannerRefresh} />

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto min-h-[300px]">
          {loading ? (
            <div className="p-6">
              <SkeletonTable rows={6} cols={8} />
            </div>
          ) : error ? (
            <div role="alert" className="flex min-h-[300px] items-center justify-center px-6 text-center">
              <div>
                <p className="font-medium text-gray-800">Unable to load shifts</p>
                <p className="mt-1 text-xs text-gray-500">{error}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] px-4 py-2 text-sm font-bold text-white shadow-lg shadow-purple-500/30 hover:bg-[#7C3AED]"
                >
                  <RefreshCw size={14} /> Retry
                </button>
              </div>
            </div>
          ) : shifts.length === 0 ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center text-gray-400">
              <Clock size={40} className="opacity-25 mb-3" />
              <p className="text-sm font-medium">No shifts yet</p>
              <p className="text-xs mt-1">Open a shift above to start tracking the cash drawer.</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase font-semibold border-b border-gray-100">
                <tr>
                  <th className="px-5 py-3">Opened</th>
                  <th className="px-5 py-3">Closed</th>
                  <th className="px-5 py-3">Cashier</th>
                  <th className="px-5 py-3 text-right">Opening</th>
                  <th className="px-5 py-3 text-right">Sales</th>
                  <th className="px-5 py-3 text-right">Expected cash</th>
                  <th className="px-5 py-3 text-right">Counted</th>
                  <th className="px-5 py-3 text-right">Variance</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {shifts.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50/60">
                    <td className="px-5 py-3 whitespace-nowrap">{dateTime(s.openedAt)}</td>
                    <td className="px-5 py-3 whitespace-nowrap">{s.closedAt ? dateTime(s.closedAt) : <span className="text-gray-400">—</span>}</td>
                    <td className="px-5 py-3">
                      {s.openedBy?.name ?? '—'}
                      {s.closedBy && s.closedBy.id !== s.openedBy?.id ? <span className="block text-[11px] text-gray-400">closed by {s.closedBy.name}</span> : null}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{money(s.openingCash)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {money(s.totalSales)}
                      <span className="block text-[11px] text-gray-400">
                        cash {money(s.cashSales)} · udhar {money(s.udharSales)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-medium text-gray-800">{money(s.expectedCash)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{s.closingCash === null ? '—' : money(s.closingCash)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {s.variance === null ? (
                        '—'
                      ) : (
                        <span className={`font-bold ${s.variance === 0 ? 'text-green-600' : s.variance > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                          {signedMoney(s.variance)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={s.status === 'OPEN' ? 'success' : 'default'}>{s.status === 'OPEN' ? 'Open' : 'Closed'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

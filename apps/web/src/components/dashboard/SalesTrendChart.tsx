'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import type { TrendPoint } from '@/lib/api-client';

/** The recharts part of the dashboard trend card; loaded with `next/dynamic` so recharts stays out of the initial bundle (roadmap 6.8). */
export default function SalesTrendChart({ trend }: { trend: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={trend} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
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
  );
}

'use client';

import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';

/** The recharts parts of the analytics page; loaded with `next/dynamic` (roadmap 6.8). */

export interface TrendPointView {
  date: string;
  sales: number;
}

export interface ShareSlice {
  name: string;
  value: number;
  color: string;
}

export interface CategoryShare extends ShareSlice {
  amount: number;
}

interface TrendTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string | number;
}

function TrendTooltip({ active, payload, label }: TrendTooltipProps) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-gray-900 border border-gray-700 text-white p-3 rounded-xl shadow-xl">
        <p className="font-bold text-sm mb-1">{label}</p>
        {payload.map((entry, index) => (
          <p key={index} className="text-xs flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }}></span>
            {entry.name}: <span className="font-bold">₹{Number(entry.value).toLocaleString('en-IN')}</span>
          </p>
        ))}
      </div>
    );
  }
  return null;
}

export function RevenueTrendChart({ data }: { data: TrendPointView[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
        <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} dy={10} minTickGap={24} />
        <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={(val) => `₹${val >= 1000 ? `${Math.round(val / 100) / 10}k` : val}`} />
        <RechartsTooltip content={<TrendTooltip />} />
        <Area type="monotone" dataKey="sales" name="Sales" stroke="#8B5CF6" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function PaymentModesChart({ data }: { data: ShareSlice[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={5} dataKey="value" stroke="none">
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <RechartsTooltip formatter={(value: number, name: string) => [`${value}%`, name]} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function CategorySalesChart({ data }: { data: CategoryShare[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 30, left: 20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
        <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
        <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#334155', fontWeight: 600 }} width={100} />
        <RechartsTooltip
          formatter={(value: number, _name: string, item: { payload?: { amount?: number } }) => [`${value}% (₹${Number(item?.payload?.amount ?? 0).toLocaleString('en-IN')})`, 'Share']}
          cursor={{ fill: '#f8fafc' }}
        />
        <Bar dataKey="value" name="Sales (%)" radius={[0, 4, 4, 0]} barSize={24}>
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

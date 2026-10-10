'use client';

import React from 'react';
import Link from 'next/link';
import {
  BarChart3, Clock, FileText, Package, PackageSearch, Receipt, ShoppingCart, UserPlus, Users,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';

interface QuickAction {
  icon: React.ComponentType<{ size?: number | string }>;
  label: string;
  href: string;
  color: string;
  bg: string;
}

/** Every action is a plain navigation to a page that exists. */
const QUICK_ACTIONS: QuickAction[] = [
  { icon: ShoppingCart, label: 'Create Bill', href: '/billing', color: 'text-[#8B5CF6]', bg: 'bg-[#8B5CF6]/10' },
  { icon: PackageSearch, label: 'Add Product', href: '/products', color: 'text-green-500', bg: 'bg-green-500/10' },
  { icon: UserPlus, label: 'Add Customer', href: '/customers?new=1', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  { icon: Users, label: 'Customer Udhar', href: '/customers', color: 'text-orange-500', bg: 'bg-orange-500/10' },
  { icon: Package, label: 'Low Stock', href: '/inventory?tab=low-stock', color: 'text-amber-500', bg: 'bg-amber-500/10' },
  { icon: Receipt, label: 'Expenses', href: '/expenses', color: 'text-pink-500', bg: 'bg-pink-500/10' },
  { icon: FileText, label: 'Invoices', href: '/invoices', color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
  { icon: Clock, label: 'Shifts', href: '/shifts', color: 'text-teal-500', bg: 'bg-teal-500/10' },
  { icon: BarChart3, label: 'Reports', href: '/analytics', color: 'text-[#8B5CF6]', bg: 'bg-[#8B5CF6]/10' },
];

export function QuickActionsCard({ className = '' }: { className?: string }) {
  return (
    <Card className={`bg-gray-50/50 p-5 ${className}`}>
      <h3 className="mb-4 font-bold text-gray-800">Quick Actions</h3>
      <div className="grid grid-cols-3 gap-3">
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.label}
              href={action.href}
              className="group relative flex h-[76px] flex-col items-center justify-center rounded-xl border border-gray-100 bg-white p-2 text-center shadow-sm transition-all hover:shadow-md"
            >
              <div className={`mb-1 flex h-8 w-8 items-center justify-center rounded-full ${action.bg} ${action.color} transition-transform group-hover:scale-110`}>
                <Icon size={14} />
              </div>
              <span className="text-[9px] font-semibold leading-tight text-gray-600">{action.label}</span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

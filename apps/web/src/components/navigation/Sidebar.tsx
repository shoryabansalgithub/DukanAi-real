'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, ShoppingCart, PackageSearch, UserCheck, Users,
  ClipboardList, Receipt, UserCircle, BarChart3, Bot, Bell,
  Settings, Database, ChevronDown, Sparkles, ShoppingBag, Menu, X,
  ScanLine, Camera, CheckCircle2, FileText, Clock,
} from 'lucide-react';
import { clsx } from '@/lib/utils';
import { useAppStore } from '@/store';
import { Modal } from '@/components/ui/Modal';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  badge?: string;
  badgeColor?: string;
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Billing (POS)', href: '/billing', icon: ShoppingCart },
  { name: 'Invoices', href: '/invoices', icon: FileText },
  { name: 'Shifts', href: '/shifts', icon: Clock },
  { name: 'Products / Stock', href: '/products', icon: PackageSearch },
  { name: 'Customers (Udhar)', href: '/customers', icon: UserCheck },
  { name: 'AI OCR Scanner', href: '/ai-scanner', icon: ScanLine, badge: 'Magic', badgeColor: 'bg-green-500' },
  { name: 'Smart Bill Capture', href: '/smart-capture', icon: Camera, badge: 'Mobile', badgeColor: 'bg-blue-500' },
  { name: 'Suppliers', href: '/suppliers', icon: Users },
  { name: 'Inventory', href: '/inventory', icon: ClipboardList },
  { name: 'Expenses', href: '/expenses', icon: Receipt },
  { name: 'Employees', href: '/employees', icon: UserCircle },
  { name: 'Reports & Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'AI Assistant', href: '/ai-assistant', icon: Bot, badge: 'Beta', badgeColor: 'bg-[#8B5CF6]' },
  { name: 'Notifications', href: '/notifications', icon: Bell },
  { name: 'Settings', href: '/settings', icon: Settings },
];

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, toggleSidebar } = useAppStore();
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [isDatabaseOpen, setIsDatabaseOpen] = useState(pathname.startsWith('/database'));

  return (
    <>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={sidebarOpen}
        className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-[#8B5CF6] text-white shadow-lg"
      >
        {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {sidebarOpen && (
        <div
          onClick={toggleSidebar}
          className="md:hidden fixed inset-0 bg-black/50 z-40"
        />
      )}

      <aside
        className={clsx(
          'sidebar-bg fixed left-0 top-0 h-screen w-64 text-gray-400 shadow-xl z-40 transition-transform duration-300 md:translate-x-0 flex flex-col',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo */}
        <div className="p-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-[#8B5CF6] shadow-[0_0_15px_rgba(139,92,246,0.5)]">
              <ShoppingBag size={24} strokeWidth={2.5} />
            </div>
            <div>
              <div className="font-bold text-xl text-white tracking-tight">DukaanAI</div>
              <div className="text-[10px] text-gray-400 leading-tight">AI-Powered Business Assistant</div>
            </div>
          </Link>
        </div>

        <div className="px-6 mb-2">
          <span className="text-[10px] uppercase font-bold tracking-wider text-gray-500">Main Menu</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-4 pb-4 space-y-1 scrollbar-hide" aria-label="Main">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  if (window.innerWidth < 768) toggleSidebar();
                }}
                className={clsx(
                  'flex items-center justify-between px-3 py-2.5 rounded-xl transition-all duration-200 group text-sm font-medium',
                  isActive
                    ? 'bg-[#8B5CF6] text-white shadow-[0_4px_15px_rgba(139,92,246,0.4)]'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon size={18} className={clsx(isActive ? 'text-white' : 'text-gray-400 group-hover:text-white')} />
                  <span>{item.name}</span>
                </div>
                {item.badge && (
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-md text-white font-bold', item.badgeColor)}>
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Database Manager */}
          <div className="pt-4 mt-4 border-t border-white/5">
            <button
              type="button"
              onClick={() => setIsDatabaseOpen((open) => !open)}
              aria-expanded={isDatabaseOpen}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-all"
            >
              <div className="flex items-center gap-3">
                <Database size={18} />
                <span>Database Manager</span>
              </div>
              <ChevronDown size={16} className={clsx('transition-transform', isDatabaseOpen && 'rotate-180')} />
            </button>
            {isDatabaseOpen && (
              <div className="pl-11 pr-3 pt-1 pb-2 space-y-2">
                <Link href="/database" className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors">
                  <div className="w-4 h-4 border border-gray-500 rounded flex items-center justify-center"><PackageSearch size={10} /></div>
                  Products DB
                </Link>
                <Link href="/database" className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors">
                  <div className="w-4 h-4 border border-gray-500 rounded flex items-center justify-center"><Users size={10} /></div>
                  Customers DB
                </Link>
              </div>
            )}
          </div>
        </nav>

        {/* Upgrade to Pro */}
        <div className="p-4 mt-auto">
          <div className="bg-gradient-to-br from-[#1E1B4B] to-[#2E1065] p-4 rounded-2xl border border-white/5 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-2 opacity-20">
              <Sparkles size={40} className="text-white" />
            </div>
            <h4 className="text-white font-bold text-sm flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-full bg-yellow-500/20 flex items-center justify-center">
                <Sparkles size={12} className="text-yellow-500" />
              </div>
              Upgrade to Pro <span className="text-yellow-500">✨</span>
            </h4>
            <p className="text-[11px] text-gray-300 mb-4 leading-tight">
              Unlock advanced AI insights, cloud backup & more.
            </p>
            <button
              type="button"
              onClick={() => setIsUpgradeModalOpen(true)}
              className="w-full bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-xs font-bold py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-purple-500/30">
              Upgrade Now &rarr;
            </button>
          </div>
        </div>
      </aside>

      <Modal isOpen={isUpgradeModalOpen} onClose={() => setIsUpgradeModalOpen(false)} title="Upgrade to DukaanAI Pro ✨" size="lg">
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="border border-purple-200 dark:border-purple-900/50 bg-purple-50/50 dark:bg-purple-900/10 rounded-xl p-5 relative overflow-hidden text-center cursor-pointer hover:border-purple-500 transition-colors group">
              <div className="absolute top-0 left-0 right-0 h-1 bg-purple-500" />
              <h4 className="font-bold text-gray-900 dark:text-white text-lg">Monthly</h4>
              <p className="text-3xl font-bold text-purple-600 mt-2 mb-1">₹499<span className="text-sm text-gray-500 font-medium">/mo</span></p>
              <p className="text-xs text-gray-500">Billed monthly</p>
            </div>
            <div className="border-2 border-purple-600 bg-purple-50 dark:bg-purple-900/20 rounded-xl p-5 relative overflow-hidden text-center cursor-pointer shadow-lg shadow-purple-500/10">
              <div className="absolute top-0 right-0 bg-purple-600 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg uppercase tracking-wider">Save 20%</div>
              <h4 className="font-bold text-gray-900 dark:text-white text-lg">Annual</h4>
              <p className="text-3xl font-bold text-purple-600 mt-2 mb-1">₹399<span className="text-sm text-gray-500 font-medium">/mo</span></p>
              <p className="text-xs text-purple-600 font-medium">Billed ₹4,788 yearly</p>
            </div>
          </div>

          <div>
            <h4 className="font-bold text-sm text-gray-900 dark:text-white mb-3">Pro Features Include:</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                'Advanced AI Insights & Analytics',
                'Automated Cloud Backup',
                'Multi-shop Management',
                'Priority 24/7 Support',
                'Custom Invoice Templates',
                'Scheduled Reports',
              ].map((feat) => (
                <div key={feat} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  {feat}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-4 border-t border-gray-100 dark:border-gray-800">
            <p className="text-center text-xs text-gray-500">Plans are not purchasable in-app yet. Contact support to upgrade.</p>
            <button type="button" onClick={() => setIsUpgradeModalOpen(false)} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-center font-medium">
              Close
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

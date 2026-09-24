'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, Check, Moon, Search, Sun } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { signOut, useSession } from 'next-auth/react';
import { useTheme } from '@/hooks';
import { AUTH_DISABLED } from '@/lib/auth-bypass';
import { notificationsApi, type NotificationView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { useVisibilityPolling } from '@/components/dashboard/useVisibilityPolling';

const NOTIFICATION_POLL_MS = 60 * 1000;
const DROPDOWN_LIMIT = 5;

const TYPE_DOT: Record<string, string> = {
  LOW_STOCK: 'bg-orange-500',
  UDHAR_OVERDUE: 'bg-red-500',
  SHIFT_NOT_CLOSED: 'bg-blue-500',
  PAYMENT_RECEIVED: 'bg-green-500',
  LARGE_DISCOUNT: 'bg-purple-500',
  SUSPICIOUS_ACTIVITY: 'bg-red-600',
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return '';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function Navbar() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { theme, toggleTheme, mounted } = useTheme();

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationView[] | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  // Notifications need an authenticated API; guests would only collect 401s.
  const canLoadNotifications = status === 'authenticated' || AUTH_DISABLED;

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setIsNotificationsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadNotifications = useCallback(async () => {
    if (!canLoadNotifications) return;
    setNotificationsLoading(true);
    try {
      const list = await notificationsApi.list();
      setNotifications(Array.isArray(list) ? list : []);
      setNotificationsError(null);
    } catch (err) {
      setNotificationsError(describeApiError(err, 'Loading notifications (GET /notifications)'));
    } finally {
      setNotificationsLoading(false);
    }
  }, [canLoadNotifications]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  useVisibilityPolling(() => void loadNotifications(), NOTIFICATION_POLL_MS, canLoadNotifications);

  const unreadCount = (notifications ?? []).filter((n) => !n.isRead).length;
  const latest = (notifications ?? []).slice(0, DROPDOWN_LIMIT);

  const submitSearch = () => {
    const term = searchQuery.trim();
    if (!term) return;
    setIsSearchOpen(false);
    router.push(`/products?q=${encodeURIComponent(term)}`);
  };

  const handleNotificationClick = async (notification: NotificationView) => {
    setIsNotificationsOpen(false);
    if (notification.isRead) return;
    // Optimistic: flip locally, then confirm with the API.
    setNotifications((current) => current?.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n)) ?? current);
    try {
      const updated = await notificationsApi.markRead(notification.id);
      setNotifications((current) => current?.map((n) => (n.id === updated.id ? updated : n)) ?? current);
    } catch (err) {
      describeApiError(err, 'Marking notification read (PATCH /notifications/:id/read)');
      setNotifications((current) => current?.map((n) => (n.id === notification.id ? { ...n, isRead: false } : n)) ?? current);
    }
  };

  const handleMarkAllRead = async () => {
    if (markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    try {
      await notificationsApi.markAllRead();
      setNotifications((current) => current?.map((n) => ({ ...n, isRead: true })) ?? current);
    } catch (err) {
      setNotificationsError(describeApiError(err, 'Marking notifications read (PATCH /notifications/read-all)'));
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <nav className="fixed top-0 right-0 left-0 md:left-64 h-[72px] bg-white border-b border-gray-100 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.05)] z-30 flex items-center justify-between px-6">

      {/* Search Bar — routes to the products page, which owns product search */}
      <div className="flex-1 max-w-2xl flex items-center gap-4 relative" ref={searchRef}>
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="search"
            aria-label="Search products"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch();
              if (e.key === 'Escape') setIsSearchOpen(false);
            }}
            placeholder="Search products by name, SKU or barcode…"
            className="w-full bg-gray-50/50 border border-gray-200 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-gray-700 placeholder:text-gray-400"
          />

          <AnimatePresence>
            {isSearchOpen && searchQuery.trim() && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute top-full mt-2 w-full bg-white border border-gray-100 shadow-xl rounded-xl p-2 z-50"
              >
                <button
                  type="button"
                  onClick={submitSearch}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 rounded-lg text-sm text-gray-700 transition-colors"
                >
                  Search products for <span className="font-bold">"{searchQuery.trim()}"</span> &rarr;
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex-1" />

      {/* Right section */}
      <div className="flex items-center gap-5">
        {mounted && (
          <button
            type="button"
            onClick={toggleTheme}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        )}

        {canLoadNotifications && (
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setIsNotificationsOpen((open) => !open)}
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              aria-haspopup="menu"
              aria-expanded={isNotificationsOpen}
              className="relative text-gray-400 hover:text-gray-600 transition-colors"
            >
              <Bell size={20} />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            <AnimatePresence>
              {isNotificationsOpen && (
                <motion.div
                  role="menu"
                  initial={{ opacity: 0, scale: 0.95, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 10 }}
                  className="absolute right-0 top-full mt-3 w-80 bg-white border border-gray-100 shadow-2xl rounded-xl overflow-hidden z-50"
                >
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/50">
                    <h3 className="font-bold text-gray-800 text-sm">
                      Notifications{unreadCount > 0 && <span className="ml-2 text-xs font-semibold text-[#8B5CF6]">{unreadCount} unread</span>}
                    </h3>
                    <button
                      type="button"
                      onClick={() => void handleMarkAllRead()}
                      disabled={markingAll || unreadCount === 0}
                      className="text-[#8B5CF6] text-xs font-semibold hover:underline flex items-center gap-1 disabled:opacity-40 disabled:no-underline"
                    >
                      <Check size={12} /> {markingAll ? 'Marking…' : 'Mark all read'}
                    </button>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {notifications === null && notificationsLoading && (
                      <p className="px-4 py-6 text-center text-xs text-gray-500">Loading…</p>
                    )}
                    {notificationsError && (
                      <div className="px-4 py-3 text-xs text-red-600 bg-red-50 border-b border-red-100 flex items-center justify-between gap-2">
                        <span className="truncate" title={notificationsError}>Couldn't load notifications</span>
                        <button type="button" onClick={() => void loadNotifications()} className="font-bold hover:underline shrink-0">Retry</button>
                      </div>
                    )}
                    {notifications !== null && latest.length === 0 && !notificationsError && (
                      <p className="px-4 py-6 text-center text-xs text-gray-500">You're all caught up.</p>
                    )}
                    {latest.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        role="menuitem"
                        onClick={() => void handleNotificationClick(n)}
                        className={`w-full text-left flex gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${n.isRead ? 'opacity-60' : ''}`}
                      >
                        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TYPE_DOT[n.type] ?? 'bg-gray-400'}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-bold text-gray-800 truncate">{n.title}</span>
                          <span className="block text-[11px] text-gray-500 mt-0.5 line-clamp-2">{n.message}</span>
                        </span>
                        <span className="text-[9px] text-gray-400 font-medium ml-auto whitespace-nowrap">{relativeTime(n.createdAt)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="p-2 border-t border-gray-100 text-center">
                    <Link
                      href="/notifications"
                      onClick={() => setIsNotificationsOpen(false)}
                      className="text-xs text-[#8B5CF6] font-bold hover:underline"
                    >
                      View all notifications
                    </Link>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div className="relative">
          {status === 'authenticated' ? (
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: '/login' })}
              className="flex items-center gap-3 pl-5 border-l border-gray-100 hover:bg-gray-50 p-2 rounded-xl transition-colors"
              title="Sign out"
            >
              <div className="text-right hidden sm:block">
                <p className="text-[13px] font-bold text-gray-800 leading-tight">{session.user?.name || session.user?.email}</p>
                <p className="text-[11px] text-red-500 font-bold mt-0.5 hover:underline">Sign Out</p>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-violet-100 text-sm font-bold text-violet-700">{(session.user?.name || session.user?.email || 'U').slice(0, 1).toUpperCase()}</div>
            </button>
          ) : AUTH_DISABLED ? (
            <div
              className="flex items-center gap-3 pl-5 border-l border-gray-100 p-2"
              title="Auth is disabled (AUTH_DISABLED) - requests run as the system user"
            >
              <div className="text-right hidden sm:block">
                <p className="text-[13px] font-bold text-gray-800 leading-tight">System user</p>
                <p className="text-[11px] text-gray-400 font-bold mt-0.5">Auth disabled</p>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-violet-100 text-sm font-bold text-violet-700">S</div>
            </div>
          ) : status === 'loading' ? (
            <div className="h-9 w-24 rounded-xl bg-gray-100 animate-pulse" aria-hidden="true" />
          ) : (
            <button type="button" onClick={() => router.push('/login')} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-violet-700">Sign in</button>
          )}
        </div>
      </div>
    </nav>
  );
}

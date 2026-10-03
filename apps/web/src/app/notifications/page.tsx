'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import {
  PackageOpen, AlertTriangle, UserCheck, CheckCircle2, Bell, ShieldAlert, Clock, BadgePercent,
} from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { notificationsApi, type NotificationView } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';

const TYPE_STYLES: Record<string, { icon: React.ComponentType<{ size?: number | string }>; color: string }> = {
  LOW_STOCK: { icon: AlertTriangle, color: 'text-orange-500 bg-orange-50' },
  UDHAR_OVERDUE: { icon: UserCheck, color: 'text-red-500 bg-red-50' },
  SHIFT_NOT_CLOSED: { icon: Clock, color: 'text-blue-500 bg-blue-50' },
  PAYMENT_RECEIVED: { icon: CheckCircle2, color: 'text-green-500 bg-green-50' },
  LARGE_DISCOUNT: { icon: BadgePercent, color: 'text-purple-500 bg-purple-50' },
  SUSPICIOUS_ACTIVITY: { icon: ShieldAlert, color: 'text-red-500 bg-red-50' },
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function NotificationsPage() {
  const { toast } = useToast();
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false; // stale-response guard (roadmap 6.5): nothing lands after unmount
    notificationsApi
      .list()
      .then((list) => {
        if (!cancelled) setNotifications(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(describeApiError(err, 'Loading notifications (GET /notifications)'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllRead();
      setNotifications(notifications.map((n) => ({ ...n, isRead: true })));
      toast('All notifications marked as read', 'success');
    } catch (err) {
      toast(describeApiError(err, 'Marking notifications read (PATCH /notifications/read-all)'), 'error');
    }
  };

  const handleMarkRead = async (notification: NotificationView) => {
    if (notification.isRead) return;
    try {
      const updated = await notificationsApi.markRead(notification.id);
      setNotifications(notifications.map((n) => (n.id === updated.id ? updated : n)));
    } catch (err) {
      toast(describeApiError(err, 'Marking notification read (PATCH /notifications/:id/read)'), 'error');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-10">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Notifications</h1>
          <p className="text-sm text-gray-500 mt-1">Stay updated on your store's alerts and activities.</p>
        </div>
        <button
          onClick={handleMarkAllRead}
          className="text-sm font-bold text-[#8B5CF6] hover:text-purple-700 transition-colors"
        >
          Mark all as read
        </button>
      </div>

      {loading && (
        <Card className="p-8 text-center text-sm text-gray-500">Loading notifications...</Card>
      )}

      {!loading && loadError && (
        <Card className="p-6 text-sm text-red-600 bg-red-50 border-red-100">{loadError}</Card>
      )}

      {!loading && !loadError && notifications.length === 0 && (
        <Card className="p-10 text-center text-gray-500">
          <Bell className="mx-auto h-10 w-10 text-gray-300 mb-3" />
          <p className="font-medium text-gray-800">No notifications yet</p>
          <p className="text-xs mt-1">Store alerts and activity updates will appear here.</p>
        </Card>
      )}

      {!loading && !loadError && notifications.length > 0 && (
        <Card className="p-0 overflow-hidden divide-y divide-gray-100">
          {notifications.map((n) => {
            const style = TYPE_STYLES[n.type] ?? { icon: PackageOpen, color: 'text-blue-500 bg-blue-50' };
            const Icon = style.icon;
            return (
              <div
                key={n.id}
                onClick={() => handleMarkRead(n)}
                className={`p-4 sm:p-6 flex items-start gap-4 hover:bg-gray-50 transition-colors cursor-pointer ${n.isRead ? 'opacity-60' : ''}`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${style.color}`}>
                  <Icon size={18} />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-start">
                    <h4 className="font-bold text-gray-800 flex items-center gap-2">
                      {n.title}
                      {!n.isRead && <span className="w-2 h-2 rounded-full bg-[#8B5CF6] inline-block" />}
                    </h4>
                    <span className="text-[10px] font-bold text-gray-400">{relativeTime(n.createdAt)}</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{n.message}</p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

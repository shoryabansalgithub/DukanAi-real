'use client';

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { SkeletonTable } from '@/components/ui/Skeleton';

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}

export function ErrorState({ title = 'Something went wrong', message, onRetry, retrying = false, compact = false }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`flex ${compact ? 'flex-row items-center gap-3 p-4' : 'flex-col items-center justify-center gap-3 px-6 py-12 text-center'} rounded-xl border border-red-100 bg-red-50/60`}
    >
      <AlertCircle size={compact ? 16 : 28} className="shrink-0 text-red-500" />
      <div className={compact ? 'flex-1 min-w-0' : ''}>
        <p className="text-sm font-bold text-gray-800">{title}</p>
        <p className="mt-0.5 text-xs text-gray-600 break-words">{message}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={`${compact ? 'ml-auto' : 'mt-2'} inline-flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-4 py-2 text-xs font-bold text-white shadow-lg shadow-purple-500/30 transition-all hover:bg-[#7C3AED] disabled:cursor-not-allowed disabled:opacity-60`}
        >
          <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center text-gray-500">
      {icon && <div className="mb-3 text-gray-300">{icon}</div>}
      <p className="text-sm font-bold text-gray-800">{title}</p>
      {hint && <p className="mt-1 text-xs">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-6" aria-busy="true" aria-live="polite">
      <SkeletonTable rows={rows} cols={cols} />
    </div>
  );
}

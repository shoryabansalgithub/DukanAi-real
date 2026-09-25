'use client';

import React from 'react';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/customers/States';

/** Skeleton rows for a card whose data is still loading (never an "empty" message). */
export function CardSkeletonRows({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBox key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

interface CardUnavailableProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/** The card's data could not be loaded: say so instead of showing an empty state. */
export function CardUnavailable({ title = 'Unavailable', message = 'This data could not be loaded.', onRetry, retrying }: CardUnavailableProps) {
  return <ErrorState compact title={title} message={message} onRetry={onRetry} retrying={retrying} />;
}

/** A refresh failed after data had loaded: the card keeps the last good data and says so. */
export function StaleBadge({ detail }: { detail?: string | null }) {
  return (
    <span
      role="status"
      title={detail ?? undefined}
      className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-600"
    >
      Refresh failed — showing last data
    </span>
  );
}

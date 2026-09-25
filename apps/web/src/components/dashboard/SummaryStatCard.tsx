'use client';

import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { SkeletonBox } from '@/components/ui/Skeleton';

interface SummaryStatCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Tailwind classes for the icon tile, e.g. `bg-[#8B5CF6]/10 text-[#8B5CF6]`. */
  tone: string;
  href?: string;
  loading?: boolean;
  /** The figure could not be loaded: shows a dash and "Unavailable" instead of a misleading value. */
  unavailable?: boolean;
  className?: string;
}

/** Stat tile in the dashboard's existing style: icon tile, label, value, hint. */
export function SummaryStatCard({ icon, label, value, hint, tone, href, loading = false, unavailable = false, className = '' }: SummaryStatCardProps) {
  const body = (
    <>
      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tone}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        {loading ? (
          <SkeletonBox className="mt-1 h-6 w-24" />
        ) : unavailable ? (
          <h3 className="truncate text-xl font-bold tracking-tight text-gray-400" aria-label={`${label} unavailable`}>—</h3>
        ) : (
          <h3 className="truncate text-xl font-bold tracking-tight text-gray-800">{value}</h3>
        )}
        {!loading && unavailable ? (
          <p className="mt-0.5 text-[10px] font-semibold text-red-500">Unavailable</p>
        ) : (
          hint && <p className="mt-0.5 text-[10px] font-medium text-gray-500">{hint}</p>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`block ${className}`}>
        <Card hoverable className="flex h-full items-center gap-4 p-4">{body}</Card>
      </Link>
    );
  }
  return <Card hoverable className={`flex items-center gap-4 p-4 ${className}`}>{body}</Card>;
}

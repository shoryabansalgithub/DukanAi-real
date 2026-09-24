'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationControlsProps {
  skip: number;
  take: number;
  total: number;
  onChange: (skip: number) => void;
  disabled?: boolean;
  itemLabel?: string;
}

export function PaginationControls({ skip, take, total, onChange, disabled = false, itemLabel = 'rows' }: PaginationControlsProps) {
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + take, total);
  const hasPrev = skip > 0;
  const hasNext = skip + take < total;

  return (
    <div className="flex flex-col gap-3 border-t border-gray-100 px-5 py-3 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing <span className="font-bold text-gray-800">{from}–{to}</span> of{' '}
        <span className="font-bold text-gray-800">{total.toLocaleString('en-IN')}</span> {itemLabel}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, skip - take))}
          disabled={disabled || !hasPrev}
          aria-label="Previous page"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-bold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <button
          type="button"
          onClick={() => onChange(skip + take)}
          disabled={disabled || !hasNext}
          aria-label="Next page"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-bold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

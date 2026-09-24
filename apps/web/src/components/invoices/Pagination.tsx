import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  skip: number;
  take: number;
  total: number;
  onChange: (skip: number) => void;
  disabled?: boolean;
}

export function Pagination({ skip, take, total, onChange, disabled = false }: PaginationProps) {
  const page = Math.floor(skip / take) + 1;
  const pages = Math.max(1, Math.ceil(total / take));
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(total, skip + take);
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100 text-xs text-gray-500">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous page"
          disabled={disabled || skip <= 0}
          onClick={() => onChange(Math.max(0, skip - take))}
          className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-2 font-medium text-gray-700">
          Page {page} / {pages}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={disabled || skip + take >= total}
          onClick={() => onChange(skip + take)}
          className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

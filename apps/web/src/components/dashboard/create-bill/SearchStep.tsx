'use client';

import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { posCustomersApi } from '@/lib/api-client';
import { useDebounce } from '@/hooks/useDebounce';
import { extractApiError } from '@/components/pos/api-errors';
import type { PosCustomer } from '@/types';
import type { FlowAction } from './flow';
import { FieldError, SheetBody, fieldClass, labelClass, resultRowClass, textButtonClass } from './ui';

const MIN_QUERY = 2;

type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; rows: PosCustomer[] }
  | { status: 'done'; rows: PosCustomer[]; query: string }
  | { status: 'failed'; message: string };

export function SearchStep({ query, dispatch }: { query: string; dispatch: React.Dispatch<FlowAction> }) {
  const debounced = useDebounce(query.trim(), 250);
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (debounced.length < MIN_QUERY) {
      setSearch({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setSearch((prev) => ({ status: 'searching', rows: prev.status === 'done' || prev.status === 'searching' ? prev.rows : [] }));
    posCustomersApi
      .search(debounced, { take: 8, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setSearch({ status: 'done', rows, query: debounced });
      })
      .catch((err) => {
        const info = extractApiError(err, 'Searching customers (POST /customers/search)');
        if (!info.isCanceled && !controller.signal.aborted) setSearch({ status: 'failed', message: info.message });
      });
    return () => controller.abort();
  }, [debounced, attempt]);

  const pick = (customer: PosCustomer) => dispatch({ type: 'customer', customer, created: false });
  const rows = search.status === 'done' || search.status === 'searching' ? search.rows : [];
  const typed = query.trim();

  return (
    <SheetBody end>
      <label htmlFor="create-bill-search" className={labelClass}>
        Name or phone
      </label>
      {/* tailwindboss-ignore missing-micro-spec: inherits Field / text (fieldClass, ./ui) */}
      <input
        id="create-bill-search"
        data-autofocus
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        placeholder="Search…"
        value={query}
        onChange={(e) => dispatch({ type: 'query', query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (search.status === 'done' && search.rows.length === 1) pick(search.rows[0]);
          }
        }}
        className={fieldClass}
      />

      <div aria-live="polite" className="mt-3">
        {search.status === 'idle' && (
          <p className="text-[13px] leading-[18px] text-gray-500">
            {typed.length < MIN_QUERY ? 'Type at least 2 letters' : 'Searching…'}
          </p>
        )}
        {search.status === 'searching' && rows.length === 0 && <p className="text-[13px] leading-[18px] text-gray-500">Searching…</p>}
        {search.status === 'failed' && (
          <div>
            <FieldError>{search.message}</FieldError>
            {/* tailwindboss-ignore missing-micro-spec: inherits Text button (textButtonClass, ./ui) */}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className={textButtonClass}>
              Try again
            </button>
          </div>
        )}
        {search.status === 'done' && rows.length === 0 && (
          <div>
            <p className="text-[15px] leading-5 text-gray-700">No customer called &ldquo;{search.query}&rdquo;</p>
            {/* tailwindboss-ignore missing-micro-spec: inherits Text button (textButtonClass, ./ui) */}
            <button type="button" onClick={() => dispatch({ type: 'open-new', name: search.query })} className={`${textButtonClass} mt-1`}>
              <UserPlus aria-hidden size={18} />
              Add &ldquo;{search.query}&rdquo; as new customer
            </button>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <ul aria-label="Matching customers" className="overflow-clip rounded-xl border border-gray-200 divide-y divide-gray-100">
          {rows.map((customer) => (
            <li key={customer.id}>
              {/* tailwindboss-ignore missing-micro-spec: inherits Result row (resultRowClass, ./ui) */}
              <button type="button" onClick={() => pick(customer)} className={resultRowClass}>
                <span className="min-w-0 truncate text-[15px] font-bold leading-5 text-gray-800">{customer.name}</span>
                <span className="shrink-0 text-[13px] leading-[18px] tabular-nums text-gray-500">{customer.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!(search.status === 'done' && rows.length === 0) && (
        // tailwindboss-ignore missing-micro-spec: inherits Text button (textButtonClass, ./ui)
        <button type="button" onClick={() => dispatch({ type: 'open-new' })} className={`${textButtonClass} mt-2`}>
          <UserPlus aria-hidden size={18} />
          New customer
        </button>
      )}
    </SheetBody>
  );
}

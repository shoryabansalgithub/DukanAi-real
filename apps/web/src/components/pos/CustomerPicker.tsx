'use client';

import React, { useEffect, useRef, useState } from 'react';
import { User, UserPlus, X } from 'lucide-react';
import { posCustomersApi } from '@/lib/api-client';
import { useDebounce } from '@/hooks/useDebounce';
import type { PosCustomer } from '@/types';
import { extractApiError } from './api-errors';
import { availableCredit } from './credit';
import { money } from './format';
import { INDIAN_STATES } from './indian-states';

interface CustomerPickerProps {
  customer: PosCustomer | null;
  onSelect: (customer: PosCustomer | null) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  /** Called after a selection so the page can return focus to product search. */
  onDone?: () => void;
}

const fieldClass =
  'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6]';

export function CustomerPicker({ customer, onSelect, inputRef, onDone }: CustomerPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosCustomer[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [showNew, setShowNew] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounce(query.trim(), 250);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    setSearching(true);
    setError(null);
    posCustomersApi
      .search(debounced, { take: 8, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setResults(rows);
          setOpen(true);
        }
      })
      .catch((err) => {
        const info = extractApiError(err, 'Searching customers (POST /customers/search)');
        if (!info.isCanceled && !controller.signal.aborted) setError(info.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [debounced]);

  useEffect(() => {
    setHighlight(-1);
  }, [results]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const choose = (c: PosCustomer | null) => {
    onSelect(c);
    setQuery('');
    setResults([]);
    setOpen(false);
    setShowNew(false);
    onDone?.();
  };

  if (customer) {
    const available = availableCredit(customer);
    return (
      <div className="px-4 py-3">
        <div className="flex items-start gap-3 rounded-xl border border-purple-100 bg-purple-50/60 p-3">
          <div className="w-9 h-9 rounded-full bg-[#8B5CF6]/15 text-[#8B5CF6] flex items-center justify-center shrink-0">
            <User size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-gray-800 truncate" title={customer.name}>
              {customer.name}
            </p>
            <p className="text-[11px] text-gray-500">
              {customer.phone || 'No phone'}
              {customer.state ? ` · ${customer.state}` : ''}
            </p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <dt className="text-gray-400">Limit</dt>
                <dd className="font-bold text-gray-700">{money(customer.creditLimit)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Outstanding</dt>
                <dd className={`font-bold ${customer.outstandingBalance > 0 ? 'text-red-600' : 'text-gray-700'}`}>
                  {money(customer.outstandingBalance)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">Available</dt>
                <dd className={`font-bold ${available <= 0 ? 'text-red-600' : 'text-green-600'}`}>{money(available)}</dd>
              </div>
            </dl>
          </div>
          <button
            type="button"
            aria-label="Remove customer (walk-in)"
            onClick={() => choose(null)}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-white"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3" ref={containerRef}>
      {showNew ? (
        <NewCustomerForm onCreated={choose} onCancel={() => setShowNew(false)} initialName={query} />
      ) : (
        <div className="relative">
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => results.length > 0 && setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (results.length) {
                    setOpen(true);
                    setHighlight((h) => (h + 1) % results.length);
                  }
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (results.length) setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const pick = highlight >= 0 ? results[highlight] : results.length === 1 ? results[0] : undefined;
                  if (pick) choose(pick);
                } else if (e.key === 'Escape') {
                  if (query) {
                    e.stopPropagation();
                    setQuery('');
                    setOpen(false);
                  }
                }
              }}
              placeholder="Walk-in customer — search name or phone (F4)"
              aria-label="Search customers"
              autoComplete="off"
              className={`${fieldClass} pl-9 pr-10`}
            />
            <button
              type="button"
              aria-label="Add new customer"
              title="New customer"
              onClick={() => setShowNew(true)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[#8B5CF6] hover:bg-purple-50"
            >
              <UserPlus size={16} />
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-1.5 text-[11px] text-red-600 font-medium">
              {error}
            </p>
          )}

          {open && (debounced.length >= 2 || results.length > 0) && (
            <ul
              role="listbox"
              aria-label="Matching customers"
              className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-xl"
            >
              {searching && results.length === 0 ? (
                <li className="px-3 py-2 text-xs text-gray-400">Searching…</li>
              ) : results.length === 0 ? (
                <li className="px-3 py-2 text-xs text-gray-500">
                  No customers match.{' '}
                  <button type="button" onClick={() => setShowNew(true)} className="font-bold text-[#8B5CF6] hover:underline">
                    Create &ldquo;{query.trim()}&rdquo;
                  </button>
                </li>
              ) : (
                results.map((c, index) => (
                  <li
                    key={c.id}
                    role="option"
                    aria-selected={highlight === index}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(c)}
                    className={`cursor-pointer px-3 py-2 text-sm ${highlight === index ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-gray-800 truncate">{c.name}</span>
                      <span className="text-[11px] text-gray-500 shrink-0">{c.phone}</span>
                    </div>
                    <div className="text-[11px] text-gray-500">
                      Due {money(c.outstandingBalance)} · limit {money(c.creditLimit)}
                      {c.state ? ` · ${c.state}` : ''}
                    </div>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline new-customer form
// ---------------------------------------------------------------------------

interface NewCustomerFormProps {
  initialName?: string;
  onCreated: (customer: PosCustomer) => void;
  onCancel: () => void;
}

function NewCustomerForm({ initialName = '', onCreated, onCancel }: NewCustomerFormProps) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!phone.trim()) {
      setError('Phone is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await posCustomersApi.create({
        name: name.trim(),
        phone: phone.trim(),
        state: state || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(extractApiError(err, 'Creating customer (POST /customers)').message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 space-y-2"
    >
      <p className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
        <UserPlus size={14} className="text-[#8B5CF6]" /> New customer
      </p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        aria-label="Customer name"
        autoFocus
        required
        className={fieldClass}
      />
      <input
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Phone"
        aria-label="Customer phone"
        required
        className={fieldClass}
      />
      <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Customer state" className={fieldClass}>
        <option value="">State (optional, for GST)</option>
        {INDIAN_STATES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-[11px] text-red-600 font-medium">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2 rounded-lg border border-gray-200 bg-white text-xs font-bold text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="flex-1 py-2 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-60 text-xs font-bold text-white"
        >
          {saving ? 'Saving…' : 'Save & select'}
        </button>
      </div>
    </form>
  );
}

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PackageX, RefreshCw, ScanBarcode, Search, X } from 'lucide-react';
import { SkeletonBox } from '@/components/ui/Skeleton';
import { productsApi, productToSearchResult, searchApi } from '@/lib/api-client';
import { useDebounce } from '@/hooks/useDebounce';
import type { SearchResult } from '@/types';
import { extractApiError } from './api-errors';
import { money, qty } from './format';

const GRID_LIMIT = 60;
const SEARCH_LIMIT = 30;

interface ProductSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: (product: SearchResult) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  /** productId → quantity already in the cart, for the "in cart" chip. */
  cartQuantities: Record<string, number>;
  /** Bump to reload the initial grid (stock changes after a sale). */
  refreshToken?: number;
}

export function isSellable(product: SearchResult): boolean {
  if (product.isActive === false) return false;
  const type = (product.type || 'SIMPLE').toUpperCase();
  if (type === 'SERVICE' || type === 'DIGITAL') return true;
  return product.currentStock > 0;
}

export function ProductSearch({ query, onQueryChange, onAdd, inputRef, cartQuantities, refreshToken = 0 }: ProductSearchProps) {
  const [initial, setInitial] = useState<SearchResult[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState<string | null>(null);

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [searchRetry, setSearchRetry] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  const debounced = useDebounce(query.trim(), 250);

  const loadInitial = useCallback(async () => {
    setInitialLoading(true);
    setInitialError(null);
    try {
      const products = await productsApi.list({ limit: GRID_LIMIT });
      setInitial(products.map(productToSearchResult));
    } catch (err) {
      setInitialError(extractApiError(err, 'Loading products (GET /products)').message);
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial, refreshToken]);

  useEffect(() => {
    if (!debounced) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    searchApi
      .search(debounced, { limit: SEARCH_LIMIT, signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setResults(rows);
      })
      .catch((err) => {
        const info = extractApiError(err, 'Searching products (GET /search)');
        if (!info.isCanceled && !controller.signal.aborted) setSearchError(info.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [debounced, searchRetry]);

  const isSearchMode = query.trim().length > 0;
  const visible = useMemo(() => (isSearchMode ? results ?? [] : initial).slice(0, GRID_LIMIT), [isSearchMode, results, initial]);

  useEffect(() => {
    setHighlight(-1);
  }, [visible]);

  useEffect(() => {
    if (highlight < 0 || !gridRef.current) return;
    const el = gridRef.current.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const add = useCallback(
    (product: SearchResult) => {
      onAdd(product);
      onQueryChange('');
      inputRef.current?.focus();
    },
    [onAdd, onQueryChange, inputRef],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (visible.length === 0) return;
      setHighlight((h) => (h + 1) % visible.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (visible.length === 0) return;
      setHighlight((h) => (h <= 0 ? visible.length - 1 : h - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onQueryChange('');
      setHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const highlighted = highlight >= 0 ? visible[highlight] : undefined;
      if (highlighted) {
        if (isSellable(highlighted)) add(highlighted);
        return;
      }
      const term = query.trim().toLowerCase();
      if (!term) return;
      const exact = visible.find(
        (p) => (p.barcode && p.barcode.toLowerCase() === term) || (p.sku && p.sku.toLowerCase() === term),
      );
      const candidate = exact ?? (visible.length === 1 ? visible[0] : undefined);
      if (candidate && isSellable(candidate)) add(candidate);
    }
  };

  const listboxId = 'pos-product-results';

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-100">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search name, SKU or barcode…  (F2)"
            aria-label="Search products"
            data-testid="pos-search"
            aria-controls={listboxId}
            aria-activedescendant={highlight >= 0 ? `pos-product-${highlight}` : undefined}
            autoComplete="off"
            autoFocus
            className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onQueryChange('');
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            >
              <X size={16} />
            </button>
          ) : (
            <ScanBarcode className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300" size={18} aria-hidden />
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-400 font-medium">
          Scan a barcode anywhere · ↑↓ to move · Enter to add · Esc to clear
        </p>
      </div>

      <div ref={gridRef} id={listboxId} role="listbox" aria-label="Products" className="p-4 flex-1 overflow-y-auto max-h-[60vh] lg:max-h-[calc(100vh-320px)]">
        {initialLoading && !isSearchMode ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <SkeletonBox key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : initialError && !isSearchMode ? (
          <ErrorState message={initialError} onRetry={() => void loadInitial()} />
        ) : searchError ? (
          <ErrorState message={searchError} onRetry={() => setSearchRetry((n) => n + 1)} />
        ) : searching && results === null ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonBox key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center text-gray-400">
            <PackageX size={40} className="opacity-30 mb-3" />
            <p className="text-sm font-medium">{isSearchMode ? `No products match "${query.trim()}"` : 'No products yet'}</p>
            {!isSearchMode && <p className="text-xs mt-1">Add products from the Products page to start billing.</p>}
          </div>
        ) : (
          <div className={`grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 ${searching ? 'opacity-60' : ''}`}>
            {visible.map((product, index) => {
              const sellable = isSellable(product);
              const inCart = cartQuantities[product.id];
              const active = highlight === index;
              return (
                <button
                  key={product.id}
                  id={`pos-product-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  type="button"
                  disabled={!sellable}
                  onClick={() => add(product)}
                  onMouseEnter={() => setHighlight(index)}
                  title={product.name}
                  className={`relative text-left rounded-xl border p-3 transition-all focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/40 ${
                    !sellable
                      ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                      : active
                        ? 'border-[#8B5CF6] bg-purple-50 ring-1 ring-[#8B5CF6] shadow-sm'
                        : 'border-gray-100 bg-white hover:border-[#8B5CF6] hover:shadow-sm'
                  }`}
                >
                  {inCart ? (
                    <span className="absolute top-2 right-2 rounded-full bg-[#8B5CF6] text-white text-[10px] font-bold px-1.5 py-0.5">
                      ×{qty(inCart)}
                    </span>
                  ) : null}
                  <p className={`text-xs font-bold truncate pr-8 ${active ? 'text-[#8B5CF6]' : 'text-gray-800'}`}>{product.name}</p>
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">
                    {product.sku}
                    {product.categoryName ? ` · ${product.categoryName}` : ''}
                  </p>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-gray-900 leading-none">{money(product.sellingPrice)}</p>
                      {product.mrp > product.sellingPrice && (
                        <p className="text-[10px] text-gray-400 line-through leading-none mt-1">{money(product.mrp)}</p>
                      )}
                    </div>
                    <StockBadge product={product} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StockBadge({ product }: { product: SearchResult }) {
  const type = (product.type || 'SIMPLE').toUpperCase();
  if (type === 'SERVICE' || type === 'DIGITAL') {
    return <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded px-1.5 py-0.5">Service</span>;
  }
  if (product.currentStock <= 0) {
    return <span className="text-[10px] font-bold text-red-600 bg-red-50 rounded px-1.5 py-0.5">Out of stock</span>;
  }
  const low = product.currentStock <= 5;
  return (
    <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${low ? 'text-amber-700 bg-amber-50' : 'text-gray-600 bg-gray-100'}`}>
      {qty(product.currentStock, product.unit)}
    </span>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center py-12 text-center px-4">
      <p className="text-sm font-medium text-gray-800">Unable to load products</p>
      <p className="text-xs text-gray-500 mt-1 max-w-md">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] px-4 py-2 text-sm font-bold text-white shadow-lg shadow-purple-500/30"
      >
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}

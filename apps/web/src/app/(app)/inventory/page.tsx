'use client';

import React, { Suspense, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { 
  ClipboardList, AlertTriangle, AlertOctagon, TrendingDown, 
  Search, Filter, MoreVertical, Calendar, ChevronDown, PackageMinus
} from 'lucide-react';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import { AnimatePresence, motion } from 'framer-motion';
import { inventoryApi, type BatchItem } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { LowStockPanel } from '@/components/inventory/LowStockPanel';
import { PaginationControls } from '@/components/customers/PaginationControls';

function formatBatchDate(date: string | null, options: Intl.DateTimeFormatOptions) {
  return date ? new Date(date).toLocaleDateString('en-IN', options) : 'Not recorded';
}

/** A batch's state as the table shows it: no stock left, past its expiry, within 30 days of it, or safe. */
type ExpiryStatus = 'Depleted' | 'Expired' | 'Expiring Soon' | 'Safe';

function expiryStatus(batch: BatchItem, today: Date, horizon: Date): ExpiryStatus {
  if (batch.quantity === 0) return 'Depleted';
  const expDate = batch.expDate ? new Date(batch.expDate) : null;
  if (expDate && expDate <= today) return 'Expired';
  if (expDate && expDate <= horizon) return 'Expiring Soon';
  return 'Safe';
}

/** The Filters menu: none ticked shows every batch, ticked ones narrow the list (and its search) to those states. */
const EXPIRY_FILTERS: ReadonlyArray<{ status: ExpiryStatus; label: string }> = [
  { status: 'Expired', label: 'Show Expired' },
  { status: 'Expiring Soon', label: 'Expiring < 30 Days' },
  { status: 'Safe', label: 'Safe' },
  { status: 'Depleted', label: 'Depleted (no stock)' },
];

const LOW_STOCK_TAB = 'Low Stock';
/** Rows per table page; the tiles and the search cover every batch (audit W9). */
const PAGE_SIZE = 50;
/** Only the tabs with a module behind them (roadmap 6.7): stock moves are recorded from Products › Update Stock. */
const MAIN_TABS = ['Batches & Expiry', LOW_STOCK_TAB];

/** `?tab=low-stock` (dashboard links) opens the Low Stock tab. */
function tabFromQuery(tab: string | null): string {
  return tab === 'low-stock' ? LOW_STOCK_TAB : 'Batches & Expiry';
}

function InventoryPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [batches, setBatches] = useState<BatchItem[]>([]);
  // Every batch is read page by page (`X-Total-Count`); a bound that stopped the read is said on screen.
  const [batchTotal, setBatchTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);

  useEffect(() => {
    const loadBatches = async () => {
      try {
        setLoadError(null);
        const result = await inventoryApi.listBatches();
        setBatches(result.items);
        setBatchTotal(result.total);
      } catch (err) {
        setLoadError(describeApiError(err, 'Loading inventory batches (GET /batches)'));
      } finally {
        setLoading(false);
      }
    };
    void loadBatches();
  }, []);
  const [searchTerm, setSearchTerm] = useState('');
  const [expiryFilter, setExpiryFilter] = useState<ReadonlySet<ExpiryStatus>>(() => new Set());
  // A new search or filter starts on the first page.
  useEffect(() => {
    setSkip(0);
  }, [searchTerm, expiryFilter]);

  const toggleExpiryFilter = (status: ExpiryStatus) => {
    setExpiryFilter((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };
  
  // Modals & Panels
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<BatchItem | null>(null);

  // Dropdowns & Tabs
  const [activeMainTab, setActiveMainTab] = useState(() => tabFromQuery(tabParam));

  // Follow the URL when it changes while the page is open (e.g. a dashboard link).
  useEffect(() => {
    setActiveMainTab(tabFromQuery(tabParam));
  }, [tabParam]);

  const selectTab = (tab: string) => {
    setActiveMainTab(tab);
    router.replace(tab === LOW_STOCK_TAB ? '/inventory?tab=low-stock' : '/inventory', { scroll: false });
  };
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Form State

  // Derived Stats
  const today = new Date();
  const thirtyDaysFromNow = new Date(today);
  thirtyDaysFromNow.setDate(today.getDate() + 30);

  const expiringSoonCount = batches.filter(b => {
    if (!b.expDate) return false;
    const exp = new Date(b.expDate);
    return exp > today && exp <= thirtyDaysFromNow && b.quantity > 0;
  }).length;

  const expiredCount = batches.filter(b => b.expDate && new Date(b.expDate) <= today && b.quantity > 0).length;
  const zeroStockBatches = batches.filter(b => b.quantity === 0).length;

  // Filter Logic: the search and the expiry filters apply to every batch read, then the table pages the result.
  const processedBatches = batches.filter(b =>
    (b.product.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.batchNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.sku.toLowerCase().includes(searchTerm.toLowerCase())) &&
    (expiryFilter.size === 0 || expiryFilter.has(expiryStatus(b, today, thirtyDaysFromNow)))
  );
  const pageBatches = processedBatches.slice(skip, skip + PAGE_SIZE);

  const handleAction = (action: string, batch: BatchItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);
    setSelectedBatch(batch);
    
    switch (action) {
      case 'View Timeline': 
        setIsSidePanelOpen(true);
        break;
    }
  };
  // The batch list gates only its own tab: Low Stock loads independently.
  if (loading && activeMainTab !== LOW_STOCK_TAB) return <div className="p-12 text-center text-gray-500">Loading inventory batches...</div>;
  if (loadError && activeMainTab !== LOW_STOCK_TAB) return <div className="p-12 text-center text-red-600">{loadError}</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Inventory Operations</h1>
          <p className="text-sm text-gray-500 mt-1">Track expiry dates, manage batches, and handle stock adjustments.</p>
        </div>
        <Link
          href="/products"
          className="bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
        >
          <PackageMinus size={18} />
          Adjust Stock on Products
        </Link>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center text-orange-500">
            <AlertTriangle size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Expiring Soon (30 Days)</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{expiringSoonCount} Batches</h3>
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable bg-red-50/50 border-red-100">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center text-red-600">
            <AlertOctagon size={24} />
          </div>
          <div>
            <p className="text-xs text-red-500 font-medium font-bold">Expired Stock</p>
            <h3 className="text-xl font-black text-red-700 tracking-tight">{expiredCount} Items</h3>
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-gray-500/10 flex items-center justify-center text-gray-600">
            <ClipboardList size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Empty Batches</p>
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">{zeroStockBatches}</h3>
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable">
          <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-[#8B5CF6]">
            <TrendingDown size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Monthly Wastage</p>
            {/* No module records wastage as a figure yet: say so rather than show an invented ₹0 (roadmap 6.1). */}
            <h3 className="text-xl font-bold text-gray-800 tracking-tight" title="Wastage is not recorded as a separate figure yet">Not tracked</h3>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-gray-200">
        {MAIN_TABS.map(tab => (
          <button 
            key={tab}
            onClick={() => selectTab(tab)}
            className={`pb-3 text-sm font-bold border-b-2 transition-colors ${activeMainTab === tab ? 'border-[#8B5CF6] text-[#8B5CF6]' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeMainTab === LOW_STOCK_TAB && <LowStockPanel />}

      {/* Main Content Card */}
      {activeMainTab === 'Batches & Expiry' && (
        <Card className="p-0 overflow-visible">
          {/* Toolbar */}
          <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row gap-4 justify-between items-center bg-gray-50/50">
            <div className="relative w-full sm:w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="text" 
                placeholder="Search by product, batch no, or SKU..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/20 focus:border-[#8B5CF6] transition-all"
              />
            </div>
            <div className="relative" ref={filterRef}>
              <button 
                onClick={() => setIsFilterOpen(!isFilterOpen)}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors w-full sm:w-auto justify-center"
              >
                <Filter size={16} />
                Filters{expiryFilter.size > 0 ? ` (${expiryFilter.size})` : ''} <ChevronDown size={14} />
              </button>

              <AnimatePresence>
                {isFilterOpen && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 top-full mt-2 w-48 bg-white border border-gray-100 shadow-xl rounded-xl z-20 p-4"
                  >
                    <div className="space-y-4">
                      <div>
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Expiry Status</h4>
                        <div className="flex flex-col gap-2">
                          {EXPIRY_FILTERS.map(({ status, label }) => (
                            <label key={status} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={expiryFilter.has(status)}
                                onChange={() => toggleExpiryFilter(status)}
                                className="rounded text-[#8B5CF6]"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        {expiryFilter.size > 0 && (
                          <button type="button" onClick={() => setExpiryFilter(new Set())} className="mt-3 text-xs font-bold text-[#8B5CF6] hover:underline">
                            Clear filters
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto min-h-[400px]">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50/80 text-gray-500 text-xs uppercase font-semibold border-b border-gray-100">
                <tr>
                  <th className="px-6 py-4">Product & Batch</th>
                  <th className="px-6 py-4">Mfg Date</th>
                  <th className="px-6 py-4">Expiry Date</th>
                  <th className="px-6 py-4">Quantity</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pageBatches.map((batch) => {
                  // The same rule as the filters (an empty batch is Depleted whatever its date).
                  const statusText = expiryStatus(batch, today, thirtyDaysFromNow);
                  const isExpired = statusText === 'Expired';
                  const isExpiringSoon = statusText === 'Expiring Soon';
                  const statusClass = {
                    Depleted: 'bg-gray-100 text-gray-600',
                    Expired: 'bg-red-50 text-red-600',
                    'Expiring Soon': 'bg-orange-50 text-orange-600',
                    Safe: 'bg-green-50 text-green-600',
                  }[statusText];

                  return (
                    <tr 
                      key={batch.id} 
                      onClick={() => { setSelectedBatch(batch); setIsSidePanelOpen(true); }}
                      className="hover:bg-gray-50/50 transition-colors cursor-pointer group"
                    >
                      <td className="px-6 py-4">
                        <div className="font-bold text-gray-800 block">{batch.product}</div>
                        <div className="text-xs font-mono mt-1 text-gray-500 flex items-center gap-2">
                          <span className="bg-gray-100 px-1.5 py-0.5 rounded">{batch.sku}</span>
                          <span className="bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded border border-indigo-100">{batch.batchNo}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 font-medium">{formatBatchDate(batch.mfgDate, { month: 'short', year: 'numeric' })}</td>
                      <td className="px-6 py-4">
                        <span className={`font-bold ${isExpired ? 'text-red-600' : isExpiringSoon ? 'text-orange-600' : 'text-gray-800'}`}>
                          {formatBatchDate(batch.expDate, {})}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-black text-gray-800 text-base">{batch.quantity}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${statusClass}`}>
                          {statusText}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right relative">
                        <button 
                          onClick={(e) => { e.stopPropagation(); setOpenActionMenuId(openActionMenuId === batch.id ? null : batch.id); }}
                          className="p-2 text-gray-400 hover:text-[#8B5CF6] transition-colors rounded-lg hover:bg-[#8B5CF6]/10"
                        >
                          <MoreVertical size={18} />
                        </button>

                        <AnimatePresence>
                          {openActionMenuId === batch.id && (
                            <motion.div 
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.95 }}
                              className="absolute right-8 top-10 w-48 bg-white border border-gray-100 shadow-xl rounded-xl z-50 overflow-hidden text-left"
                            >
                              {['View Timeline'].map(action => (
                                <button 
                                  key={action}
                                  onClick={(e) => handleAction(action, batch, e)}
                                  className="w-full text-left px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                                >
                                  {action}
                                </button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </td>
                    </tr>
                  );
                })}
                {processedBatches.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-16 text-center text-sm text-gray-500">
                      {batches.length === 0
                        ? 'No inventory batches yet. Add stock to a product to begin tracking batch and expiry data.'
                        : 'No batches match the search or the expiry filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {batchTotal > batches.length && (
            <p role="status" className="px-5 pt-3 text-xs font-medium text-orange-600">
              Showing the first {batches.length.toLocaleString('en-IN')} of {batchTotal.toLocaleString('en-IN')} batches: the tiles and the search cover only these.
            </p>
          )}
          {processedBatches.length > PAGE_SIZE && (
            <PaginationControls skip={skip} take={PAGE_SIZE} total={processedBatches.length} onChange={setSkip} itemLabel="batches" />
          )}
        </Card>
      )}

      {/* Side Panel for Batch Details */}
      <SlidingPanel isOpen={isSidePanelOpen} onClose={() => setIsSidePanelOpen(false)} title="Batch Lifecycle">
        {selectedBatch && (
          <div className="p-6">
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 mb-6">
              <h2 className="text-xl font-bold text-indigo-900">{selectedBatch.product}</h2>
              <div className="flex gap-4 mt-2 text-sm font-medium text-indigo-700">
                <span>SKU: {selectedBatch.sku}</span>
                <span>•</span>
                <span>Batch: {selectedBatch.batchNo}</span>
              </div>
            </div>

            <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2"><Calendar size={18} className="text-[#8B5CF6]"/> Lifecycle Timeline</h3>
            
            <div className="relative border-l-2 border-purple-200 ml-3 space-y-6 pb-4">
              <div className="relative pl-6">
                <div className="absolute w-3 h-3 bg-white border-2 border-purple-500 rounded-full -left-[7px] top-1.5" />
                <p className="text-sm font-bold text-gray-800">Manufacturing Date</p>
                <p className="text-xs text-gray-500 mt-1">{formatBatchDate(selectedBatch.mfgDate, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
              </div>
              
              <div className="relative pl-6">
                <div className="absolute w-3 h-3 bg-[#8B5CF6] rounded-full -left-[7px] top-1.5 shadow-[0_0_10px_rgba(139,92,246,0.5)]" />
                <p className="text-sm font-bold text-gray-800">Inwarded at Store</p>
                <p className="text-xs text-gray-500 mt-1">Supplier lot: {selectedBatch.supplierLotNumber ?? 'Not recorded'}</p>
                <div className="mt-2 inline-flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold text-gray-700">
                  <span className="text-green-500">{selectedBatch.quantity} units</span> recorded
                </div>
              </div>

              <div className="relative pl-6">
                <div className="absolute w-3 h-3 bg-white border-2 border-orange-500 rounded-full -left-[7px] top-1.5" />
                <p className="text-sm font-bold text-gray-800">Current Status (Today)</p>
                <div className="mt-2 inline-flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold text-gray-700">
                  <span className="text-blue-500">{selectedBatch.quantity} units</span> remaining
                </div>
              </div>

              <div className="relative pl-6">
                <div className="absolute w-3 h-3 bg-red-500 rounded-full -left-[7px] top-1.5 shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
                <p className="text-sm font-bold text-red-600">Expiry Date</p>
                <p className="text-xs text-red-500 mt-1 font-medium">{formatBatchDate(selectedBatch.expDate, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
              </div>
            </div>

            <div className="mt-8 border-t border-gray-100 pt-6">
              <Link
                href={`/products?q=${encodeURIComponent(selectedBatch.sku ?? '')}`}
                className="w-full bg-red-50 text-red-600 hover:bg-red-100 py-3 rounded-xl text-sm font-bold transition-colors border border-red-200 flex items-center justify-center gap-2"
              >
                <PackageMinus size={16} /> Record Wastage / Expiry on Products
              </Link>
            </div>
          </div>
        )}
      </SlidingPanel>
    </div>
  );
}

export default function InventoryPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-gray-500">Loading inventory…</div>}>
      <InventoryPageContent />
    </Suspense>
  );
}

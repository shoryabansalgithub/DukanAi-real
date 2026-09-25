'use client';

import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { 
  ClipboardList, AlertTriangle, AlertOctagon, TrendingDown, 
  Search, Filter, FileText, ArrowRightLeft, MoreVertical, Calendar, ChevronDown, PackageMinus
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import { useToast } from '@/components/ui/Toast';
import { AnimatePresence, motion } from 'framer-motion';
import { inventoryApi, type BatchItem } from '@/lib/api-client';
import { describeApiError } from '@/lib/api-error';
import { LowStockPanel } from '@/components/inventory/LowStockPanel';

function formatBatchDate(date: string | null, options: Intl.DateTimeFormatOptions) {
  return date ? new Date(date).toLocaleDateString('en-IN', options) : 'Not recorded';
}

const LOW_STOCK_TAB = 'Low Stock';
const MAIN_TABS = ['Batches & Expiry', LOW_STOCK_TAB, 'Stock Adjustments', 'Purchase Orders'];

/** `?tab=low-stock` (dashboard links) opens the Low Stock tab. */
function tabFromQuery(tab: string | null): string {
  return tab === 'low-stock' ? LOW_STOCK_TAB : 'Batches & Expiry';
}

function InventoryPageContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const loadBatches = async () => {
      try {
        setLoadError(null);
        setBatches(await inventoryApi.listBatches());
      } catch (err) {
        setLoadError(describeApiError(err, 'Loading inventory batches (GET /batches)'));
      } finally {
        setLoading(false);
      }
    };
    void loadBatches();
  }, []);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modals & Panels
  const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<any>(null);

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
  const [adjustType, setAdjustType] = useState('Wastage');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

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

  // Filter Logic
  const processedBatches = batches.filter(b => 
    b.product.toLowerCase().includes(searchTerm.toLowerCase()) || 
    b.batchNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
    b.sku.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleAdjustStock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustQty || Number(adjustQty) <= 0) return;

    // Persisting an adjustment requires the physical inventory location and a
    // ledger entry. Do not mutate client state and falsely report success.
    toast('Choose a product inventory location before recording an adjustment.', 'info');
    setIsAdjustModalOpen(false);
    setAdjustQty(''); setAdjustReason('');
    setSelectedBatch(null);
  };

  const handleAction = (action: string, batch: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);
    setSelectedBatch(batch);
    
    switch (action) {
      case 'View Timeline': 
        setIsSidePanelOpen(true);
        break;
      case 'Adjust Stock':
        setIsAdjustModalOpen(true);
        break;
      case 'Print Barcode':
        toast(`Printing barcode for Batch ${batch.batchNo}...`, 'info');
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
        <div className="flex gap-3">
          <button 
            onClick={() => { setSelectedBatch(null); setIsAdjustModalOpen(true); }}
            className="bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
          >
            <PackageMinus size={18} />
            Adjust Stock
          </button>
          <button 
            onClick={() => toast('Stock Transfer module coming soon', 'info')}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-purple-500/30 transition-all"
          >
            <ArrowRightLeft size={18} />
            Stock Transfer
          </button>
        </div>
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
            <h3 className="text-xl font-bold text-gray-800 tracking-tight">₹0</h3>
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
                Filters <ChevronDown size={14} />
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
                          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-[#8B5CF6]"/> Show Expired</label>
                          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-[#8B5CF6]"/> Expiring &lt; 30 Days</label>
                          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded text-[#8B5CF6]"/> Safe</label>
                        </div>
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
                {processedBatches.map((batch) => {
                  const expDate = batch.expDate ? new Date(batch.expDate) : null;
                  const isExpired = Boolean(expDate && expDate <= today && batch.quantity > 0);
                  const isExpiringSoon = Boolean(!isExpired && expDate && expDate <= thirtyDaysFromNow && batch.quantity > 0);
                  const isEmpty = batch.quantity === 0;

                  let statusText = 'Safe';
                  let statusClass = 'bg-green-50 text-green-600';
                  
                  if (isEmpty) {
                    statusText = 'Depleted';
                    statusClass = 'bg-gray-100 text-gray-600';
                  } else if (isExpired) {
                    statusText = 'Expired';
                    statusClass = 'bg-red-50 text-red-600';
                  } else if (isExpiringSoon) {
                    statusText = 'Expiring Soon';
                    statusClass = 'bg-orange-50 text-orange-600';
                  }

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
                              {['View Timeline', 'Adjust Stock', 'Print Barcode'].map(action => (
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
                      No inventory batches yet. Add stock to a product to begin tracking batch and expiry data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {activeMainTab !== 'Batches & Expiry' && activeMainTab !== LOW_STOCK_TAB && (
        <Card className="p-16 flex flex-col items-center justify-center text-center min-h-[400px] border-dashed">
          <FileText size={48} className="text-gray-300 mb-4" />
          <h3 className="text-xl font-bold text-gray-800">Module Coming Soon</h3>
          <p className="text-sm text-gray-500 mt-2 max-w-sm">The {activeMainTab} features are currently under development in the Beta version.</p>
        </Card>
      )}

      {/* Adjust Stock Modal */}
      <Modal isOpen={isAdjustModalOpen} onClose={() => setIsAdjustModalOpen(false)} title={selectedBatch ? `Adjust Batch: ${selectedBatch.batchNo}` : "General Stock Adjustment"} size="md">
        <form onSubmit={handleAdjustStock} className="space-y-4">
          {!selectedBatch && (
            <div>
              <label className="text-sm font-medium">Search Product/Batch</label>
              <input className="w-full mt-1 border rounded-lg p-2" placeholder="Scan barcode or type name..." />
            </div>
          )}
          
          <div>
            <label className="text-sm font-medium">Adjustment Type</label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {['Wastage', 'Addition', 'Return'].map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAdjustType(type)}
                  className={`py-2 rounded-lg text-sm font-bold transition-all border ${
                    adjustType === type 
                      ? type === 'Wastage' ? 'bg-red-50 border-red-200 text-red-600' 
                        : type === 'Addition' ? 'bg-green-50 border-green-200 text-green-600'
                        : 'bg-orange-50 border-orange-200 text-orange-600'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Quantity *</label>
            <input 
              value={adjustQty} 
              onChange={e=>setAdjustQty(e.target.value)} 
              type="number" 
              required 
              min="1"
              max={adjustType !== 'Addition' ? selectedBatch?.quantity : undefined}
              className="w-full mt-1 border rounded-lg p-3 text-lg font-bold" 
              placeholder="0" 
            />
          </div>

          <div>
            <label className="text-sm font-medium">Reason / Remarks</label>
            <textarea 
              value={adjustReason}
              onChange={e=>setAdjustReason(e.target.value)}
              className="w-full mt-1 border rounded-lg p-2 h-20 resize-none" 
              placeholder="e.g. Expired items, damaged in transit..."
            ></textarea>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" onClick={() => setIsAdjustModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30">Confirm Adjustment</button>
          </div>
        </form>
      </Modal>

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
                <p className="text-xs text-gray-500 mt-1">{new Date(selectedBatch.mfgDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
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
                <p className="text-xs text-red-500 mt-1 font-medium">{new Date(selectedBatch.expDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
              </div>
            </div>

            <div className="mt-8 border-t border-gray-100 pt-6">
              <button 
                onClick={() => { setIsSidePanelOpen(false); setIsAdjustModalOpen(true); }}
                className="w-full bg-red-50 text-red-600 hover:bg-red-100 py-3 rounded-xl text-sm font-bold transition-colors border border-red-200 flex items-center justify-center gap-2"
              >
                <PackageMinus size={16} /> Record Wastage / Expiry
              </button>
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

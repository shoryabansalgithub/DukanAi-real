'use client';

import React, { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Card } from '@/components/ui/Card';
import {
  PackageSearch, Plus, Search, Filter, MoreVertical,
  AlertTriangle, ChevronDown, PackageOpen, Box, TrendingUp, IndianRupee, Pencil
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SlidingPanel } from '@/components/ui/SlidingPanel';
import { useToast } from '@/components/ui/Toast';
import { analyticsApi, categoriesApi, productsApi, type CategoryView, type DashboardSummary, type ProductStockFilter } from '@/lib/api-client';
import apiClient from '@/lib/api';
import { describeApiError } from '@/lib/api-error';
import { AUTH_DISABLED } from '@/lib/auth-bypass';
import { gstLabel } from '@/components/pos/format';
import type { Product, GstRate, ProductUnit } from '@/types';
import { AnimatePresence, motion } from 'framer-motion';

/** One page of the server list (`GET /products?limit&offset`, roadmap 6.2). */
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const GST_RATES: Array<{ value: GstRate; label: string }> = [
  { value: 'ZERO', label: '0%' },
  { value: 'FIVE', label: '5%' },
  { value: 'TWELVE', label: '12%' },
  { value: 'EIGHTEEN', label: '18%' },
  { value: 'TWENTYEIGHT', label: '28%' },
];

const UNITS: Array<{ value: ProductUnit; label: string }> = [
  { value: 'PCS', label: 'Pieces (PCS)' },
  { value: 'KG', label: 'Kilogram (KG)' },
  { value: 'GM', label: 'Gram (GM)' },
  { value: 'LTR', label: 'Litre (LTR)' },
  { value: 'ML', label: 'Millilitre (ML)' },
  { value: 'BOX', label: 'Box' },
  { value: 'PACK', label: 'Pack' },
  { value: 'DOZEN', label: 'Dozen' },
  { value: 'BUNDLE', label: 'Bundle' },
];

/** Stock-status filter labels (UI) → API `stock` values; the API applies the dashboard's reorder-point rule. */
const STATUS_FILTERS: Array<{ label: string; value: ProductStockFilter | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'In Stock', value: 'in' },
  { label: 'Low Stock', value: 'low' },
  { label: 'Out of Stock', value: 'out' },
];

const STOCKLESS_TYPES = new Set(['SERVICE', 'DIGITAL']);
const WRITE_ROLES = new Set(['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);
const DELETE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPER_ADMIN']);
const hasRole = (roles: Set<string>, role: string | null | undefined) => AUTH_DISABLED || (!!role && roles.has(role.toUpperCase()));

type StockStatus = 'In Stock' | 'Low Stock' | 'Out of Stock';

/** Same rule as the API's `stock` filter and the dashboard alerts: at or below the product's reorder point is low. */
function stockStatusOf(product: Product): StockStatus {
  if (STOCKLESS_TYPES.has(product.type ?? 'SIMPLE')) return 'In Stock';
  if (product.quantity <= 0) return 'Out of Stock';
  if (product.quantity <= (product.reorderPoint ?? 10)) return 'Low Stock';
  return 'In Stock';
}

interface ProductForm {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  price: string;
  cost: string;
  mrp: string;
  gstRate: GstRate;
  unit: ProductUnit;
  qty: string;
}

const EMPTY_FORM: ProductForm = { name: '', sku: '', barcode: '', category: '', price: '', cost: '', mrp: '', gstRate: 'EIGHTEEN', unit: 'PCS', qty: '' };

function parseMoney(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Stats tiles come from the dashboard summary (contract §6); a failed section is shown as unavailable, never as 0. */
type Stats = Pick<DashboardSummary, 'totalProducts' | 'lowStockCount' | 'outOfStockCount' | 'inventoryValue'>;

function ProductsPageContent() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  // Roadmap 6.6: the navbar search lands on `/products?q=…`; the box follows the URL.
  const urlQuery = (searchParams.get('q') ?? '').trim();
  const allowWrite = hasRole(WRITE_ROLES, session?.user?.role);
  const allowDelete = hasRole(DELETE_ROLES, session?.user?.role);

  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [searchTerm, setSearchTerm] = useState(urlQuery);
  const [debouncedTerm, setDebouncedTerm] = useState(urlQuery);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [categories, setCategories] = useState<CategoryView[]>([]);

  // Modals & Panels
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isStockAdjustModalOpen, setIsStockAdjustModalOpen] = useState(false);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [activeTab, setActiveTab] = useState('Details');
  const [saving, setSaving] = useState(false);

  // Dropdowns
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const filterRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  // Filters (applied by the API, roadmap 6.2)
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');

  // Form State
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<ProductForm>(EMPTY_FORM);
  const [adjustmentQuantity, setAdjustmentQuantity] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('CORRECTION');
  const [adjustmentNotes, setAdjustmentNotes] = useState('');
  const [isAdjustingStock, setIsAdjustingStock] = useState(false);

  const stockFilter = STATUS_FILTERS.find((s) => s.label === statusFilter)?.value;

  const fetchStats = useCallback(async () => {
    try {
      setStatsLoading(true);
      setStatsError(null);
      const summary = await analyticsApi.dashboardSummary();
      setStats({
        totalProducts: summary.totalProducts,
        lowStockCount: summary.lowStockCount,
        outOfStockCount: summary.outOfStockCount,
        inventoryValue: summary.inventoryValue,
      });
    } catch (err) {
      setStatsError(describeApiError(err, 'Loading product stats (GET /dashboard/summary)'));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchProducts = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      setIsLoading(true);
      setError(null);
      const page = await productsApi.listPage({
        q: debouncedTerm || undefined,
        limit: PAGE_SIZE,
        offset: pageIndex * PAGE_SIZE,
        categoryId: categoryFilter !== 'All' ? categoryFilter : undefined,
        stock: stockFilter,
      });
      if (seq !== requestSeq.current) return; // a newer request has taken over
      setProducts(page.items);
      setTotal(page.total);
      // The page vanished under us (a delete on the last row of the last page): step back.
      if (page.items.length === 0 && page.total > 0 && pageIndex > 0) setPageIndex(Math.max(0, Math.ceil(page.total / PAGE_SIZE) - 1));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(describeApiError(err, 'Loading products (GET /products)'));
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [debouncedTerm, pageIndex, categoryFilter, stockFilter]);

  const resolveCategoryId = async (categoryName: string): Promise<string | undefined> => {
    const trimmedCategory = categoryName.trim();
    if (!trimmedCategory) return undefined;
    const existing = categories.find((category) => category.name.toLowerCase() === trimmedCategory.toLowerCase());
    if (existing) return existing.id;
    const created = await categoriesApi.create(trimmedCategory);
    setCategories((current) => [...current, created]);
    return created.id;
  };

  const applyInitialStock = async (productId: string, quantity: number) => {
    if (quantity <= 0) return;
    const { data: inventoryItem } = await apiClient.post<{ id: string }>('/inventory-domain', { productId });
    await apiClient.post(`/inventory-domain/${inventoryItem.id}/adjust`, {
      reason: 'OPENING_BALANCE',
      quantityChange: quantity,
      notes: 'Opening stock from Products page',
    });
  };

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(searchTerm.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  // A new navbar search while already on this page changes only the URL.
  useEffect(() => {
    setSearchTerm(urlQuery);
    setDebouncedTerm(urlQuery);
  }, [urlQuery]);

  // A new query or filter starts at the first page.
  useEffect(() => {
    setPageIndex(0);
  }, [debouncedTerm, categoryFilter, stockFilter]);

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    void fetchStats();
    categoriesApi
      .list()
      .then(setCategories)
      .catch((err) => toast(describeApiError(err, 'Loading categories (GET /categories)'), 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const renderStatValue = (value: number | null | undefined, format: (n: number) => string = (n) => String(n)) => {
    if (statsLoading) {
      return <div className="mt-1 h-6 w-16 rounded-md bg-gray-200 animate-pulse" />;
    }

    if (statsError || value === null || value === undefined) {
      return <h3 className="text-xl font-bold text-gray-400 tracking-tight" title={statsError ?? 'This figure is unavailable right now'}>—</h3>;
    }

    return <h3 className="text-xl font-bold text-gray-800 tracking-tight">{format(value)}</h3>;
  };

  const pageStart = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, pageIndex * PAGE_SIZE + products.length);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryOptions = useMemo(() => [{ id: 'All', name: 'All' }, ...categories], [categories]);

  const readForm = (source: ProductForm): { error: string; value?: undefined } | { error?: undefined; value: { name: string; price: number; cost: number; mrp: number } } => {
    const price = parseMoney(source.price);
    const cost = parseMoney(source.cost);
    const mrp = parseMoney(source.mrp);
    if (!source.name.trim()) return { error: 'Enter a product name.' };
    if (price === null) return { error: 'Enter a selling price of 0 or more.' };
    // Roadmap 6.2: the cost price is what you paid, never guessed from the selling price.
    if (cost === null) return { error: 'Enter the cost price (what you pay per unit). Use 0 if there is none.' };
    if (source.mrp.trim() !== '' && mrp === null) return { error: 'The MRP must be a number of 0 or more.' };
    if (mrp !== null && mrp < price) return { error: 'The MRP cannot be below the selling price.' };
    return { value: { name: source.name.trim(), price, cost, mrp: mrp ?? price } };
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = readForm(form);
    if (parsed.error !== undefined) {
      toast(parsed.error, 'error');
      return;
    }
    const initialQuantity = Number(form.qty) || 0;

    try {
      setSaving(true);
      const categoryId = await resolveCategoryId(form.category);
      const createdProduct = await productsApi.create({
        name: parsed.value.name,
        sku: form.sku.trim() || undefined, // blank: the API numbers it (SKU-000001)
        barcode: form.barcode.trim() || undefined,
        sellingPrice: parsed.value.price,
        costPrice: parsed.value.cost,
        mrp: parsed.value.mrp,
        gstRate: form.gstRate,
        unit: form.unit,
        categoryId,
      });

      let stockAdjusted = true;
      try {
        await applyInitialStock(createdProduct.id, initialQuantity);
      } catch (stockError) {
        console.error('[api] Setting initial stock (POST /inventory-domain/:id/adjust) failed:', stockError);
        stockAdjusted = false;
      }

      toast(
        stockAdjusted ? `${createdProduct.name} added (SKU ${createdProduct.sku})` : `${createdProduct.name} added (SKU ${createdProduct.sku}), but initial stock could not be set.`,
        stockAdjusted ? 'success' : 'info'
      );
      setIsAddModalOpen(false);
      setForm(EMPTY_FORM);
      // Re-read the page and the tiles: the list is server-ordered and the totals live on the API.
      await Promise.all([fetchProducts(), fetchStats()]);
    } catch (err) {
      toast(describeApiError(err, 'Saving product (POST /products)'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (product: Product) => {
    setSelectedProduct(product);
    setEditForm({
      name: product.name,
      sku: product.sku,
      barcode: product.barcode ?? '',
      category: product.category === 'General' && !product.categoryId ? '' : product.category,
      price: String(product.sellingPrice ?? product.price),
      cost: String(product.cost),
      mrp: String(product.mrp ?? product.price),
      gstRate: (GST_RATES.some((r) => r.value === product.gstRate) ? product.gstRate : 'EIGHTEEN') as GstRate,
      unit: (UNITS.some((u) => u.value === product.unit) ? product.unit : 'PCS') as ProductUnit,
      qty: '',
    });
    setIsEditModalOpen(true);
  };

  const handleEditProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    const parsed = readForm(editForm);
    if (parsed.error !== undefined) {
      toast(parsed.error, 'error');
      return;
    }
    try {
      setSaving(true);
      const categoryId = editForm.category.trim() ? await resolveCategoryId(editForm.category) : null;
      const updated = await productsApi.update(selectedProduct.id, {
        name: parsed.value.name,
        barcode: editForm.barcode.trim() ? editForm.barcode.trim() : null,
        sellingPrice: parsed.value.price,
        costPrice: parsed.value.cost,
        mrp: parsed.value.mrp,
        gstRate: editForm.gstRate,
        unit: editForm.unit,
        categoryId,
      });
      // The PATCH answer carries no category relation; keep the name we resolved.
      const merged: Product = { ...updated, category: editForm.category.trim() || 'General', quantity: selectedProduct.quantity };
      setProducts((current) => current.map((p) => (p.id === merged.id ? merged : p)));
      setSelectedProduct(merged);
      setIsEditModalOpen(false);
      toast(`${merged.name} updated`, 'success');
      void fetchStats();
    } catch (err) {
      toast(describeApiError(err, 'Updating product (PATCH /products/:id)'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async () => {
    const target = pendingDelete;
    if (!target) return;
    try {
      setSaving(true);
      await productsApi.delete(target.id);
      setPendingDelete(null);
      if (selectedProduct?.id === target.id) {
        setIsSidePanelOpen(false);
        setSelectedProduct(null);
      }
      toast(`${target.name} deleted`, 'success');
      await Promise.all([fetchProducts(), fetchStats()]);
    } catch (err) {
      toast(describeApiError(err, `Deleting ${target.name} (DELETE /products/:id)`), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAction = (action: string, product: Product, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenActionMenuId(null);
    setSelectedProduct(product);

    switch (action) {
      case 'View Details':
        setIsSidePanelOpen(true);
        break;
      case 'Update Stock':
        setAdjustmentQuantity('');
        setAdjustmentReason('CORRECTION');
        setAdjustmentNotes('');
        setIsStockAdjustModalOpen(true);
        break;
      case 'Edit Product':
        openEdit(product);
        break;
      case 'Delete':
        setPendingDelete(product);
        break;
    }
  };

  const handleStockAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;

    const quantityChange = Number(adjustmentQuantity);
    if (!Number.isFinite(quantityChange) || quantityChange === 0) {
      toast('Enter a non-zero stock adjustment.', 'error');
      return;
    }

    try {
      setIsAdjustingStock(true);
      const { data: inventoryItem } = await apiClient.post<{ id: string }>('/inventory-domain', {
        productId: selectedProduct.id,
      });
      await apiClient.post(`/inventory-domain/${inventoryItem.id}/adjust`, {
        reason: adjustmentReason,
        quantityChange,
        notes: adjustmentNotes || undefined,
      });

      const refreshedProduct = await productsApi.get(selectedProduct.id);
      setProducts((current) => current.map((product) => product.id === refreshedProduct.id ? refreshedProduct : product));
      setSelectedProduct(refreshedProduct);
      setIsStockAdjustModalOpen(false);
      toast('Stock updated successfully.', 'success');
      void fetchStats();
    } catch (error) {
      toast(describeApiError(error, 'Updating stock (POST /inventory-domain/:id/adjust)'), 'error');
    } finally {
      setIsAdjustingStock(false);
    }
  };

  const renderProductFields = (
    state: ProductForm,
    setState: React.Dispatch<React.SetStateAction<ProductForm>>,
    mode: 'add' | 'edit',
  ) => {
    const update = (patch: Partial<ProductForm>) => setState((current) => ({ ...current, ...patch }));
    return (
      <>
        <div><label className="text-sm font-medium">Product Name *</label><input value={state.name} onChange={e=>update({ name: e.target.value })} required className="w-full mt-1 border rounded-lg p-2" /></div>
        <div className="grid grid-cols-2 gap-4">
          {mode === 'add' ? (
            <div><label className="text-sm font-medium">SKU</label><input value={state.sku} onChange={e=>update({ sku: e.target.value })} className="w-full mt-1 border rounded-lg p-2" placeholder="Leave blank: numbered by the server" /></div>
          ) : (
            <div><label className="text-sm font-medium">SKU</label><input value={state.sku} readOnly className="w-full mt-1 border rounded-lg p-2 bg-gray-50 text-gray-500 font-mono" /></div>
          )}
          <div><label className="text-sm font-medium">Category</label><input value={state.category} onChange={e=>update({ category: e.target.value })} list="product-category-options" className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. Snacks" /></div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div><label className="text-sm font-medium">Selling Price (₹) *</label><input value={state.price} onChange={e=>update({ price: e.target.value })} type="number" min="0" step="0.01" required className="w-full mt-1 border rounded-lg p-2" /></div>
          <div><label className="text-sm font-medium">Cost Price (₹) *</label><input value={state.cost} onChange={e=>update({ cost: e.target.value })} type="number" min="0" step="0.01" required className="w-full mt-1 border rounded-lg p-2" placeholder="What you pay per unit" /></div>
          {mode === 'add' ? (
            <div><label className="text-sm font-medium">Initial Stock</label><input value={state.qty} onChange={e=>update({ qty: e.target.value })} type="number" min="0" className="w-full mt-1 border rounded-lg p-2" /></div>
          ) : (
            <div><label className="text-sm font-medium">Barcode</label><input value={state.barcode} onChange={e=>update({ barcode: e.target.value })} className="w-full mt-1 border rounded-lg p-2" placeholder="Optional" /></div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-sm font-medium">GST Rate *</label>
            <select value={state.gstRate} onChange={e=>update({ gstRate: e.target.value as GstRate })} aria-label="GST Rate" className="w-full mt-1 border rounded-lg p-2 bg-white">
              {GST_RATES.map((rate) => <option key={rate.value} value={rate.value}>{rate.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Unit *</label>
            <select value={state.unit} onChange={e=>update({ unit: e.target.value as ProductUnit })} aria-label="Unit" className="w-full mt-1 border rounded-lg p-2 bg-white">
              {UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
            </select>
          </div>
          <div><label className="text-sm font-medium">MRP (₹)</label><input value={state.mrp} onChange={e=>update({ mrp: e.target.value })} type="number" min="0" step="0.01" className="w-full mt-1 border rounded-lg p-2" placeholder="Defaults to selling price" /></div>
        </div>
      </>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Products & Stock</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your inventory, pricing, and stock levels.</p>
        </div>
        {allowWrite && (
          <button
            onClick={() => { setForm(EMPTY_FORM); setIsAddModalOpen(true); }}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-purple-500/30 transition-all"
          >
            <Plus size={18} />
            Add Product
          </button>
        )}
      </div>

      {/* Stats Row (from GET /dashboard/summary; a failed section shows as unavailable) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-5 flex items-center gap-4 hoverable" data-testid="stat-total-products">
          <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-[#8B5CF6]">
            <PackageSearch size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Total Products</p>
            {renderStatValue(stats?.totalProducts)}
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable" data-testid="stat-low-stock">
          <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center text-orange-500">
            <AlertTriangle size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Low Stock Alerts</p>
            {renderStatValue(stats?.lowStockCount)}
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable" data-testid="stat-out-of-stock">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500">
            <PackageOpen size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Out of Stock</p>
            {renderStatValue(stats?.outOfStockCount)}
          </div>
        </Card>
        <Card className="p-5 flex items-center gap-4 hoverable" data-testid="stat-inventory-value">
          <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center text-green-500">
            <IndianRupee size={24} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-medium">Inventory Value</p>
            {renderStatValue(stats?.inventoryValue, (n) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`)}
          </div>
        </Card>
      </div>

      {/* Main Content Card */}
      <Card className="p-0 overflow-visible">
        {/* Toolbar */}
        <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row gap-4 justify-between items-center bg-gray-50/50">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Search by product name or SKU..."
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
                  className="absolute right-0 top-full mt-2 w-64 bg-white border border-gray-100 shadow-xl rounded-xl z-20 p-4"
                >
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Stock Status</h4>
                      <div className="flex flex-wrap gap-2">
                        {STATUS_FILTERS.map(s => (
                          <button
                            key={s.label}
                            onClick={() => setStatusFilter(s.label)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${statusFilter === s.label ? 'bg-[#8B5CF6] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Category</h4>
                      <select
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        aria-label="Category filter"
                        className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm text-gray-700 outline-none focus:border-[#8B5CF6]"
                      >
                        {categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
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
                <th className="px-6 py-4">Product Info</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4">Selling Price</th>
                <th className="px-6 py-4">Stock Qty</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && products.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="h-8 w-8 rounded-full border-2 border-[#8B5CF6]/20 border-t-[#8B5CF6] animate-spin" />
                      <div>
                        <p className="font-medium text-gray-800">Loading products...</p>
                        <p className="mt-1 text-xs text-gray-500">Fetching your latest inventory data.</p>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16">
                    <div className="flex flex-col items-center gap-4 text-center">
                      <div>
                        <p className="font-medium text-gray-800">{error}</p>
                        <p className="mt-1 text-xs text-gray-500">Please try again.</p>
                      </div>
                      <button
                        onClick={() => void fetchProducts()}
                        className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-600 transition-colors hover:bg-red-100"
                      >
                        Retry
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <>
                  {products.map((product) => {
                    const status = stockStatusOf(product);
                    const isOutOfStock = status === 'Out of Stock';
                    const isLowStock = status === 'Low Stock';

                    return (
                      <tr
                        key={product.id}
                        data-testid={`product-row-${product.id}`}
                        onClick={() => { setSelectedProduct(product); setIsSidePanelOpen(true); }}
                        className="hover:bg-gray-50/50 transition-colors cursor-pointer group"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400">
                              <Box size={20} />
                            </div>
                            <div>
                              <span className="font-bold text-gray-800 block">{product.name}</span>
                              <span className="text-xs text-gray-500 font-mono mt-0.5 block">{product.sku}</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 font-medium text-gray-600">{product.category}</td>
                        <td className="px-6 py-4 font-bold text-gray-800">₹{product.price}</td>
                        <td className="px-6 py-4 font-bold text-gray-800">{product.quantity}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                            isOutOfStock ? 'bg-red-50 text-red-600' :
                            isLowStock ? 'bg-orange-50 text-orange-600' :
                            'bg-green-50 text-green-600'
                          }`}>
                            {status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right relative">
                          <button
                            aria-label={`Actions for ${product.name}`}
                            onClick={(e) => { e.stopPropagation(); setOpenActionMenuId(openActionMenuId === product.id ? null : product.id); }}
                            className="p-2 text-gray-400 hover:text-[#8B5CF6] transition-colors rounded-lg hover:bg-[#8B5CF6]/10"
                          >
                            <MoreVertical size={18} />
                          </button>

                          <AnimatePresence>
                            {openActionMenuId === product.id && (
                              <motion.div
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="absolute right-8 top-10 w-48 bg-white border border-gray-100 shadow-xl rounded-xl z-50 overflow-hidden text-left"
                              >
                                {['View Details', ...(allowWrite ? ['Update Stock', 'Edit Product'] : [])].map(action => (
                                  <button
                                    key={action}
                                    onClick={(e) => handleAction(action, product, e)}
                                    className="w-full text-left px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-50 font-medium transition-colors"
                                  >
                                    {action}
                                  </button>
                                ))}
                                {allowDelete && (
                                  <>
                                    <div className="h-px bg-gray-100 w-full" />
                                    <button
                                      onClick={(e) => handleAction('Delete', product, e)}
                                      className="w-full text-left px-4 py-2.5 text-xs text-red-600 hover:bg-red-50 font-bold transition-colors"
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </td>
                      </tr>
                    );
                  })}
                  {products.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                        <Box className="mx-auto h-12 w-12 text-gray-300 mb-3" />
                        <p className="font-medium text-gray-800">No products found</p>
                        <p className="text-xs mt-1">Try adjusting your filters or search.</p>
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination (server pages of PAGE_SIZE) */}
        {!error && total > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500" data-testid="products-pagination">
            <span>
              Showing <span className="font-bold text-gray-700">{pageStart}–{pageEnd}</span> of <span className="font-bold text-gray-700" data-testid="products-total">{total}</span> products
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                disabled={pageIndex === 0 || isLoading}
                className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <span className="font-medium">Page {pageIndex + 1} of {pageCount}</span>
              <button
                type="button"
                onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
                disabled={pageIndex + 1 >= pageCount || isLoading}
                className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>

      <datalist id="product-category-options">
        {categories.map((category) => <option key={category.id} value={category.name} />)}
      </datalist>

      {/* Add Product Modal */}
      <Modal isOpen={isAddModalOpen} onClose={() => !saving && setIsAddModalOpen(false)} title="Add New Product" size="md">
        <form onSubmit={handleSaveProduct} className="space-y-4">
          {renderProductFields(form, setForm, 'add')}
          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" disabled={saving} onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30 disabled:opacity-60">{saving ? 'Saving…' : 'Save Product'}</button>
          </div>
        </form>
      </Modal>

      {/* Edit Product Modal */}
      <Modal isOpen={isEditModalOpen} onClose={() => !saving && setIsEditModalOpen(false)} title={selectedProduct ? `Edit Product: ${selectedProduct.name}` : 'Edit Product'} size="md">
        <form onSubmit={handleEditProduct} className="space-y-4">
          {renderProductFields(editForm, setEditForm, 'edit')}
          <div className="flex justify-end gap-2 pt-4 border-t mt-6">
            <button type="button" disabled={saving} onClick={() => setIsEditModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold shadow-lg shadow-purple-500/30 disabled:opacity-60">{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal isOpen={pendingDelete !== null} onClose={() => !saving && setPendingDelete(null)} title="Delete Product" size="sm">
        {pendingDelete && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700"><span className="font-bold">{pendingDelete.name}</span> ({pendingDelete.sku}) will be removed from your catalogue and the POS. Its sales history stays on record.</p>
            <div className="flex justify-end gap-2 pt-4 border-t">
              <button type="button" disabled={saving} onClick={() => setPendingDelete(null)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void handleDeleteProduct()} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold shadow-lg shadow-red-500/30 disabled:opacity-60">{saving ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isStockAdjustModalOpen}
        onClose={() => !isAdjustingStock && setIsStockAdjustModalOpen(false)}
        title={selectedProduct ? `Adjust Stock: ${selectedProduct.name}` : 'Adjust Stock'}
        size="md"
      >
        <form onSubmit={handleStockAdjustment} className="space-y-4">
          <p className="text-sm text-gray-500">Use a positive quantity to add stock or a negative quantity to reduce it.</p>
          <div>
            <label className="text-sm font-medium">Quantity change *</label>
            <input value={adjustmentQuantity} onChange={(e) => setAdjustmentQuantity(e.target.value)} type="number" step="0.001" required className="w-full mt-1 border rounded-lg p-2" placeholder="e.g. 10 or -2" />
          </div>
          <div>
            <label className="text-sm font-medium">Reason *</label>
            <select value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} className="w-full mt-1 border rounded-lg p-2">
              <option value="CORRECTION">Correction</option>
              <option value="MANUAL_COUNT">Manual count</option>
              <option value="DAMAGE">Damage</option>
              <option value="LOSS">Loss</option>
              <option value="RETURN">Return</option>
              <option value="EXPIRY">Expiry</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Notes</label>
            <textarea value={adjustmentNotes} onChange={(e) => setAdjustmentNotes(e.target.value)} className="w-full mt-1 border rounded-lg p-2" rows={3} />
          </div>
          <div className="flex justify-end gap-2 pt-4 border-t">
            <button type="button" disabled={isAdjustingStock} onClick={() => setIsStockAdjustModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={isAdjustingStock} className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-sm font-bold disabled:opacity-50">{isAdjustingStock ? 'Saving…' : 'Save adjustment'}</button>
          </div>
        </form>
      </Modal>

      {/* Side Panel for Details */}
      <SlidingPanel isOpen={isSidePanelOpen} onClose={() => setIsSidePanelOpen(false)} title="Product Details">
        {selectedProduct && (
          <div className="p-6">
            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-400">
                <Box size={32} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-800">{selectedProduct.name}</h2>
                <p className="text-sm text-gray-500 font-mono mt-0.5">SKU: {selectedProduct.sku}</p>
                <p className="text-xs text-gray-500 mt-0.5">GST {gstLabel(selectedProduct.gstRate)} · per {selectedProduct.unit ?? 'PCS'}{selectedProduct.barcode ? ` · Barcode ${selectedProduct.barcode}` : ''}</p>
                <div className="mt-2">
                   <span className="px-2 py-0.5 bg-blue-100 text-blue-600 rounded text-xs font-bold">{selectedProduct.category}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-4 border-b border-gray-100 mb-6">
              {['Details', 'Stock History'].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`pb-2 text-sm font-bold border-b-2 transition-colors ${activeTab === tab ? 'border-[#8B5CF6] text-[#8B5CF6]' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'Details' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Selling Price</p>
                    <p className="font-bold text-gray-800 text-lg">₹{selectedProduct.price}</p>
                    {selectedProduct.mrp !== undefined && selectedProduct.mrp !== selectedProduct.price && (
                      <p className="text-xs text-gray-500 mt-1">MRP ₹{selectedProduct.mrp}</p>
                    )}
                  </div>
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Cost Price</p>
                    <p className="font-bold text-gray-800 text-lg">₹{selectedProduct.cost}</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Current Stock</p>
                    <p className={`font-bold text-lg ${stockStatusOf(selectedProduct) === 'Out of Stock' ? 'text-red-500' : stockStatusOf(selectedProduct) === 'Low Stock' ? 'text-orange-500' : 'text-green-500'}`}>
                      {selectedProduct.quantity} {selectedProduct.unit ?? 'units'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Low below {selectedProduct.reorderPoint ?? 10}</p>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <p className="text-xs text-gray-500 mb-1">Stock Value (at cost)</p>
                    <p className="font-bold text-gray-800 text-lg">₹{(selectedProduct.cost * selectedProduct.quantity).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</p>
                  </div>
                </div>

                <div className="mt-6 border-t border-gray-100 pt-6">
                  <h4 className="text-sm font-bold text-gray-800 mb-2">Description</h4>
                  <p className="text-sm text-gray-600">{selectedProduct.description || 'No description provided.'}</p>
                </div>

                {allowWrite && (
                  <>
                    <button
                      onClick={() => { setIsSidePanelOpen(false); setAdjustmentQuantity(''); setAdjustmentReason('CORRECTION'); setAdjustmentNotes(''); setIsStockAdjustModalOpen(true); }}
                      className="w-full mt-4 bg-purple-50 text-[#8B5CF6] hover:bg-purple-100 py-3 rounded-xl text-sm font-bold transition-colors border border-purple-200 flex items-center justify-center gap-2"
                    >
                      <TrendingUp size={16} /> Update Stock Level
                    </button>
                    <button
                      onClick={() => { setIsSidePanelOpen(false); openEdit(selectedProduct); }}
                      className="w-full mt-2 bg-white text-gray-700 hover:bg-gray-50 py-3 rounded-xl text-sm font-bold transition-colors border border-gray-200 flex items-center justify-center gap-2"
                    >
                      <Pencil size={16} /> Edit Product
                    </button>
                  </>
                )}
              </div>
            )}

            {activeTab === 'Stock History' && (
              <div className="p-6 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
                Per-product stock movement history is not available yet. Use the
                Inventory page to review batches and adjustments.
              </div>
            )}
          </div>
        )}
      </SlidingPanel>
    </div>
  );
}

/** `useSearchParams` needs a Suspense boundary for the static shell (`next build`). */
export default function ProductsPage() {
  return (
    <Suspense fallback={<div className="p-8 flex justify-center"><div className="h-8 w-8 animate-spin rounded-full border-b-2 border-[#8B5CF6]" /></div>}>
      <ProductsPageContent />
    </Suspense>
  );
}

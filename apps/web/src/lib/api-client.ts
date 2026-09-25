import apiClient from './api';
import type {
  Product,
  Customer,
  SearchResult,
  PosCustomer,
  ShopProfile,
  InvoiceSummary,
  InvoiceDetail,
  InvoiceDetailItem,
  InvoicePayment,
  Shift,
  ReceiptPayload,
  CreateInvoiceResponse,
  TenderType,
  InvoiceType,
  InvoiceStatus,
  PaymentMode,
  ShiftStatus,
  ReceiptGstRow,
  GstRate,
  ProductUnit,
} from '@/types';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
async function get<T>(url: string): Promise<T> {
  const { data } = await apiClient.get<T>(url);
  return data;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const { data } = await apiClient.post<T>(url, body);
  return data;
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const { data } = await apiClient.patch<T>(url, body);
  return data;
}

async function del(url: string): Promise<void> {
  await apiClient.delete(url);
}

/** Prisma Decimal fields serialize as strings ("12.50") — always coerce. */
function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Nullable Decimal → number | null. */
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Builds `?a=1&b=2` from a params object, skipping empty values. */
function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// Field mapping — backend Prisma shapes → frontend types
// ---------------------------------------------------------------------------

function mapProduct(raw: Record<string, unknown>): Product {
  return {
    id: raw.id as string,
    name: raw.name as string,
    sku: (raw.sku as string) ?? '',
    price: toNumber(raw.sellingPrice ?? raw.mrp),
    cost: toNumber(raw.costPrice),
    quantity: toNumber(raw.quantity ?? raw.currentStock),
    category:
      (raw.category as { name?: string } | undefined)?.name ??
      (typeof raw.category === 'string' ? (raw.category as string) : undefined) ??
      (raw.categoryName as string) ??
      'General',
    description: (raw.description as string) ?? undefined,
    image: ((raw.images as Array<{ url: string }>) ?? [])[0]?.url ?? (raw.image as string) ?? undefined,
    gstRate: (raw.gstRate as string) ?? 'ZERO',
    barcode: (raw.barcode as string) ?? undefined,
    isActive: raw.isActive as boolean | undefined,
    isDeleted: raw.isDeleted as boolean | undefined,
    trackInventory: raw.trackInventory as boolean | undefined,
    currentStock: toNumber(raw.currentStock),
    brand: (raw.brand as { name?: string } | undefined)?.name ?? (raw.brand as string) ?? undefined,
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    variants: Array.isArray(raw.variants) ? raw.variants : [],
    tax: toNumber(raw.tax),
    unit: (raw.unit as string) ?? 'PCS',
    type: (raw.type as string) ?? 'SIMPLE',
    mrp: toNumber(raw.mrp ?? raw.sellingPrice),
    sellingPrice: toNumber(raw.sellingPrice ?? raw.mrp),
    cessRate: toNumber(raw.cessRate),
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export const productsApi = {
  /** `GET /products?q&limit&offset` (limit max 200). Returns an array of products. */
  list: (params?: { q?: string; limit?: number; offset?: number }) => {
    const qs = buildQuery({ q: params?.q, limit: params?.limit, offset: params?.offset });
    return get<unknown[]>(`/products${qs}`).then((arr) =>
      (Array.isArray(arr) ? arr : []).map((item) => mapProduct(item as Record<string, unknown>)),
    );
  },

  /** `GET /search?q&limit` mapped onto the full Product shape (lean search rows). */
  search: (query: string, options?: { signal?: AbortSignal; limit?: number }) => {
    const config = options?.signal ? { signal: options.signal } : {};
    const qs = buildQuery({ q: query, limit: options?.limit ?? 30 });
    return apiClient
      .get<unknown[]>(`/search${qs}`, config)
      .then((res) => (Array.isArray(res.data) ? res.data : []).map((item) => mapProduct(item as Record<string, unknown>)));
  },

  get: (id: string) =>
    get<Record<string, unknown>>(`/products/${id}`).then(mapProduct),

  create: (data: {
    name: string;
    sku: string;
    sellingPrice: number;
    costPrice: number;
    mrp: number;
    categoryId?: string;
    unit?: string;
  }) =>
    post<Record<string, unknown>>('/products', {
      ...data,
      unit: data.unit ?? 'PCS',
      mrp: data.mrp ?? data.sellingPrice,
      wholesalePrice: data.sellingPrice,
    }).then(mapProduct),

  update: (id: string, data: Record<string, unknown>) =>
    patch<Record<string, unknown>>(`/products/${id}`, data).then(mapProduct),

  delete: (id: string) => del(`/products/${id}`),
};

// ---------------------------------------------------------------------------
// Customers — contract §4 (docs/POS_BILLING_CONTRACT.md)
// ---------------------------------------------------------------------------
export type CustomerTender = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export interface PageParams {
  skip?: number;
  take?: number;
}

/**
 * Customer row as served by the API. Superset of the legacy `Customer` type:
 * `udharAmount` / `totalSpent` / `lastPurchase` are kept as aliases so older
 * consumers keep compiling, but new code should read `outstandingBalance`,
 * `totalPurchases` and `lastPurchaseAt`.
 */
export interface CustomerView extends Customer {
  email: string;
  address: string;
  city: string;
  state: string;
  creditLimit: number;
  /** Positive = owes the shop; negative = advance / store credit. */
  outstandingBalance: number;
  totalPurchases: number;
  totalPaid: number;
  isActive: boolean;
  notes: string | null;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
  createdAt: string | null;
}

/** `UdharTransaction` row from `GET /customers/:id/ledger`. */
export interface CustomerLedgerEntry {
  id: string;
  /** CREDIT | PAYMENT | ADJUSTMENT | WRITEOFF */
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  tender: CustomerTender | null;
  reference: string | null;
  notes: string | null;
  invoice: { id: string; invoiceNumber: string } | null;
  recordedBy: { name: string } | null;
  createdAt: string;
}

/** Invoice summary from `GET /customers/:id/invoices` (same shape as `GET /billing/invoices` items). */
export interface CustomerInvoiceSummary {
  id: string;
  invoiceNumber: string;
  /** SALE | SALES_RETURN */
  type: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  udharAmount: number;
  changeAmount: number;
  paymentMode: string;
  createdAt: string;
  itemCount: number | null;
  returnedAmount: number;
}

/** `GET /customers/:id`: the customer plus its last 10 invoices and ledger rows. */
export interface CustomerDetail extends CustomerView {
  invoices: CustomerInvoiceSummary[];
  udharTransactions: CustomerLedgerEntry[];
}

export interface CustomerListParams extends PageParams {
  q?: string;
}

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  creditLimit?: number;
  notes?: string;
}

export interface CustomerUpdateInput extends Partial<CustomerInput> {
  isActive?: boolean;
}

export interface RecordCustomerPaymentInput {
  /** uuid v4, generated once per attempt and reused on retry. */
  idempotencyKey: string;
  amount: number;
  tender: CustomerTender;
  reference?: string;
  notes?: string;
  /** Lets the balance go negative (advance / store credit). */
  allowAdvance?: boolean;
}

function toQueryString<T extends object>(params: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Accepts the contract `{ items, total }` envelope. A bare array (legacy
 * backend build) is tolerated so the UI degrades to "everything on one page"
 * instead of crashing while the API is being rewritten.
 */
function toPaginated<T>(data: unknown, mapItem: (raw: Record<string, unknown>) => T): PaginatedResult<T> {
  if (Array.isArray(data)) {
    const items = data.map((item) => mapItem(item as Record<string, unknown>));
    return { items, total: items.length };
  }
  const envelope = (data ?? {}) as { items?: unknown; total?: unknown };
  const items = Array.isArray(envelope.items)
    ? envelope.items.map((item) => mapItem(item as Record<string, unknown>))
    : [];
  return { items, total: toNumber(envelope.total, items.length) };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapCustomer(raw: Record<string, unknown>): CustomerView {
  // Backend field is Customer.outstandingBalance (Prisma Decimal → string).
  const outstandingBalance = toNumber(raw.outstandingBalance ?? raw.udharAmount ?? raw.outstandingUdhar);
  const totalPurchases = toNumber(raw.totalPurchases ?? raw.totalSpent);
  const lastPurchaseAt = nullableString(raw.lastPurchaseAt ?? raw.lastPurchase);
  const createdAt = nullableString(raw.createdAt);
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? '',
    phone: (raw.phone as string) ?? '',
    email: (raw.email as string) ?? '',
    address: (raw.address as string) ?? '',
    city: (raw.city as string) ?? '',
    state: (raw.state as string) ?? '',
    creditLimit: toNumber(raw.creditLimit, 0),
    outstandingBalance,
    udharAmount: outstandingBalance,
    totalPurchases,
    totalSpent: totalPurchases,
    totalPaid: toNumber(raw.totalPaid),
    isActive: raw.isActive !== false,
    notes: nullableString(raw.notes),
    lastPurchaseAt,
    lastPurchase: lastPurchaseAt ?? undefined,
    lastPaymentAt: nullableString(raw.lastPaymentAt),
    createdAt,
    joinedAt: createdAt ?? undefined,
  };
}

function mapLedgerEntry(raw: Record<string, unknown>): CustomerLedgerEntry {
  const invoice = raw.invoice as { id?: string; invoiceNumber?: string } | null | undefined;
  const recordedBy = raw.recordedBy as { name?: string } | null | undefined;
  return {
    id: raw.id as string,
    type: (raw.type as string) ?? '',
    amount: toNumber(raw.amount),
    balanceBefore: toNumber(raw.balanceBefore),
    balanceAfter: toNumber(raw.balanceAfter),
    tender: (nullableString(raw.tender) as CustomerTender | null) ?? null,
    reference: nullableString(raw.reference),
    notes: nullableString(raw.notes),
    invoice: invoice?.id ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber ?? '' } : null,
    recordedBy: recordedBy?.name ? { name: recordedBy.name } : null,
    createdAt: (raw.createdAt as string) ?? '',
  };
}

function mapCustomerInvoice(raw: Record<string, unknown>): CustomerInvoiceSummary {
  return {
    id: raw.id as string,
    invoiceNumber: (raw.invoiceNumber as string) ?? '',
    type: (raw.type as string) ?? 'SALE',
    status: (raw.status as string) ?? '',
    totalAmount: toNumber(raw.totalAmount),
    paidAmount: toNumber(raw.paidAmount),
    udharAmount: toNumber(raw.udharAmount),
    changeAmount: toNumber(raw.changeAmount),
    paymentMode: (raw.paymentMode as string) ?? '',
    createdAt: (raw.createdAt as string) ?? '',
    itemCount: raw.itemCount === undefined || raw.itemCount === null ? null : toNumber(raw.itemCount),
    returnedAmount: toNumber(raw.returnedAmount),
  };
}

function mapCustomerDetail(raw: Record<string, unknown>): CustomerDetail {
  const invoices = Array.isArray(raw.invoices)
    ? raw.invoices.map((invoice) => mapCustomerInvoice(invoice as Record<string, unknown>))
    : [];
  const udharTransactions = Array.isArray(raw.udharTransactions)
    ? raw.udharTransactions.map((txn) => mapLedgerEntry(txn as Record<string, unknown>))
    : [];
  return { ...mapCustomer(raw), invoices, udharTransactions };
}

export const customersApi = {
  /** `GET /customers?q&skip&take` → `{ items, total }`. */
  list: (params: CustomerListParams = {}) =>
    get<unknown>(`/customers${toQueryString(params)}`).then((data) => toPaginated(data, mapCustomer)),

  get: (id: string) => get<Record<string, unknown>>(`/customers/${id}`).then(mapCustomer),

  /** `GET /customers/:id` with the embedded last-10 invoices and ledger rows. */
  getDetail: (id: string) => get<Record<string, unknown>>(`/customers/${id}`).then(mapCustomerDetail),

  /** `GET /customers/:id/ledger?skip&take` → `{ items, total }` of ledger rows. */
  ledger: (id: string, params: PageParams = {}) =>
    get<unknown>(`/customers/${id}/ledger${toQueryString(params)}`).then((data) =>
      toPaginated(data, mapLedgerEntry),
    ),

  /** `GET /customers/:id/invoices?skip&take` → `{ items, total }` of invoice summaries. */
  invoices: (id: string, params: PageParams = {}) =>
    get<unknown>(`/customers/${id}/invoices${toQueryString(params)}`).then((data) =>
      toPaginated(data, mapCustomerInvoice),
    ),

  create: (data: CustomerInput) => post<Record<string, unknown>>('/customers', data).then(mapCustomer),

  update: (id: string, data: CustomerUpdateInput) =>
    patch<Record<string, unknown>>(`/customers/${id}`, data).then(mapCustomer),

  /**
   * `POST /customers/:id/payments` → `{ customer, transaction }`.
   * `409 PAYMENT_EXCEEDS_OUTSTANDING` unless `allowAdvance` is set.
   */
  recordPayment: (id: string, data: RecordCustomerPaymentInput) =>
    post<{ customer: Record<string, unknown>; transaction: Record<string, unknown> }>(
      `/customers/${id}/payments`,
      data,
    ).then((result) => ({
      customer: mapCustomer(result.customer ?? {}),
      transaction: mapLedgerEntry(result.transaction ?? {}),
    })),

  /** `DELETE /customers/:id` (soft delete). `409 CUSTOMER_HAS_BALANCE` when the balance is not zero. */
  remove: (id: string) => del(`/customers/${id}`),

  /** `POST /customers/search { query, take }` → array of customers. */
  search: (query: string, take = 10) =>
    post<unknown>('/customers/search', { query, take }).then((data) =>
      (Array.isArray(data) ? data : []).map((item) => mapCustomer(item as Record<string, unknown>)),
    ),
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
export interface BatchItem {
  id: string;
  product: string;
  sku: string;
  batchNo: string;
  quantity: number;
  expDate: string | null;
  mfgDate: string | null;
  supplierLotNumber: string | null;
  status: string;
}

export const inventoryApi = {
  listBatches: () => get<BatchItem[]>('/batches'),

  listProducts: () => get<unknown[]>('/inventory/products'),
};

// ---------------------------------------------------------------------------
// Analytics — backed by the API's /dashboard controller (contract §6)
// ---------------------------------------------------------------------------
export interface DashboardRecentInvoice {
  id: string;
  invoiceNumber: string;
  /** SALE | SALES_RETURN */
  type: string;
  status: string;
  totalAmount: number;
  paymentMode: string;
  createdAt: string;
  customer: { id?: string; name: string } | null;
}

/** Shift shape from contract §3, as embedded in the dashboard summary. */
export interface DashboardShift {
  id: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  expectedCash: number;
  closingCash: number | null;
  variance: number | null;
  totalSales: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  udharSales: number;
  totalReceipts: number;
  openedBy: { id: string; name: string } | null;
  closedBy: { id: string; name: string } | null;
}

export type DashboardSummarySection =
  | 'today'
  | 'todayProfit'
  | 'allTime'
  | 'customers'
  | 'products'
  | 'udhar'
  | 'stock'
  | 'inventoryValue'
  | 'recentInvoices'
  | 'paymentModes'
  | 'shift';

export interface LowStockItem {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  currentStock: number;
  reorderPoint: number;
  status: 'OUT_OF_STOCK' | 'LOW_STOCK';
}

export interface LowStockList {
  lowStockCount: number;
  outOfStockCount: number;
  items: LowStockItem[];
}

/** Figures of a section listed in `failedSections` are null (lists empty). */
export interface DashboardSummary {
  businessDate: string;
  timezone: string;
  failedSections: DashboardSummarySection[];
  todayGrossSales: number | null;
  todayReturns: number | null;
  /** Net: gross sales minus returns. */
  todaySales: number | null;
  /** Gross profit: taxable value minus cost of goods, net of returns. */
  todayProfit: number | null;
  todayOrders: number | null;
  todayReturnCount: number | null;
  /** Net, all time. */
  totalRevenue: number | null;
  totalOrders: number | null;
  totalCustomers: number | null;
  totalProducts: number | null;
  outstandingUdhar: number | null;
  lowStockCount: number | null;
  outOfStockCount: number | null;
  /** Most urgent stock alerts, out of stock first (at most 5). */
  lowStockItems: LowStockItem[];
  inventoryValue: number | null;
  recentInvoices: DashboardRecentInvoice[];
  /** Today, per tender plus udhar, net of refunds (adds up to today's net sales). */
  paymentModes: Array<{ mode: string; amount: number }>;
  /** The caller's OPEN shift, or null. */
  shift: DashboardShift | null;
}

export type InsightSection = 'forecast' | 'restock' | 'topProduct';

export interface RestockSuggestion {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  currentStock: number;
  reorderPoint: number;
  avgDailyUnits: number;
  daysOfCover: number | null;
  suggestedQuantity: number;
  urgency: 'OUT_OF_STOCK' | 'CRITICAL' | 'LOW';
  reason: string;
}

export interface DashboardInsights {
  businessDate: string;
  generatedAt: string;
  failedSections: InsightSection[];
  forecast: {
    forecastNetRevenue: number;
    basisDays: number;
    confidence: 'LOW' | 'MEDIUM';
    basisFrom: string;
    basisTo: string;
    todayNetSales: number;
    progressPct: number | null;
  } | null;
  restock: { basisDays: number; coverDays: number; items: RestockSuggestion[] } | null;
  topProduct: { productId: string; name: string; sku: string; unitsSold: number; netRevenue: number; grossProfit: number; grossMarginPct: number } | null;
}

export interface DashboardKpis {
  businessDate: string;
  grossRevenue: number;
  netRevenue: number;
  totalRefunds: number;
  orders: number;
  avgOrderValue: number;
}

export interface TrendPoint {
  date: string;
  sales: number;
}

export type AnalyticsRange = 'today' | 'week' | 'month' | 'year';

export type ExportKind = 'invoices' | 'invoice-items' | 'gst-summary';

export interface AnalyticsPagePayload {
  kpis: {
    totalRevenue: number;
    netProfit: number;
    udharOutstanding: number;
    avgOrderValue: number;
    revenueChangePct: number | null;
    profitChangePct: number | null;
    aovChangePct: number | null;
  };
  revenueTrend: TrendPoint[];
  paymentModes: Array<{ name: string; value: number; amount: number }>;
  categorySales: Array<{ name: string; value: number; amount: number }>;
  topCustomers: Array<{ name: string; frequency: number; spent: number }>;
}

function mapDashboardUserRef(raw: unknown): { id: string; name: string } | null {
  const ref = raw as { id?: string; name?: string } | null | undefined;
  return ref && typeof ref.name === 'string' ? { id: ref.id ?? '', name: ref.name } : null;
}

function mapDashboardShift(raw: unknown): DashboardShift | null {
  if (!raw || typeof raw !== 'object') return null;
  const shift = raw as Record<string, unknown>;
  if (!shift.id) return null;
  return {
    id: shift.id as string,
    status: (shift.status as string) ?? 'OPEN',
    openedAt: (shift.openedAt as string) ?? '',
    closedAt: (shift.closedAt as string | null) ?? null,
    openingCash: toNumber(shift.openingCash),
    expectedCash: toNumber(shift.expectedCash),
    closingCash: shift.closingCash === null || shift.closingCash === undefined ? null : toNumber(shift.closingCash),
    variance: shift.variance === null || shift.variance === undefined ? null : toNumber(shift.variance),
    totalSales: toNumber(shift.totalSales),
    cashSales: toNumber(shift.cashSales),
    upiSales: toNumber(shift.upiSales),
    cardSales: toNumber(shift.cardSales),
    udharSales: toNumber(shift.udharSales),
    totalReceipts: toNumber(shift.totalReceipts),
    openedBy: mapDashboardUserRef(shift.openedBy),
    closedBy: mapDashboardUserRef(shift.closedBy),
  };
}

/** Thrown when a dashboard endpoint answers with a body that is not the documented shape. */
export class DashboardPayloadError extends Error {
  constructor(endpoint: string) {
    super(`the API returned an unexpected response for ${endpoint}`);
    this.name = 'DashboardPayloadError';
  }
}

/** Dashboard reads give up after this long so a hung request becomes a retryable error. */
export const DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(raw: unknown, endpoint: string, keys: string[] = ['businessDate']): Record<string, unknown> {
  if (!isRecord(raw) || keys.some((key) => typeof raw[key] !== 'string')) throw new DashboardPayloadError(endpoint);
  return raw;
}

function mapLowStockItem(item: unknown): LowStockItem {
  const row = isRecord(item) ? item : {};
  return {
    productId: (row.productId as string) ?? '',
    name: (row.name as string) ?? '',
    sku: (row.sku as string) ?? '',
    unit: (row.unit as string) ?? '',
    currentStock: toNumber(row.currentStock),
    reorderPoint: toNumber(row.reorderPoint),
    status: row.status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'LOW_STOCK',
  };
}

function mapDashboardSummary(payload: unknown): DashboardSummary {
  const raw = requireRecord(payload, 'GET /dashboard/summary', ['businessDate', 'timezone']);
  if (!Array.isArray(raw.recentInvoices) || !Array.isArray(raw.paymentModes)) {
    throw new DashboardPayloadError('GET /dashboard/summary');
  }
  const recentInvoices = raw.recentInvoices.map((item): DashboardRecentInvoice => {
    const invoice = item as Record<string, unknown>;
    const customer = invoice.customer as { id?: string; name?: string } | null | undefined;
    return {
      id: invoice.id as string,
      invoiceNumber: (invoice.invoiceNumber as string) ?? '',
      type: (invoice.type as string) ?? 'SALE',
      status: (invoice.status as string) ?? '',
      totalAmount: toNumber(invoice.totalAmount),
      paymentMode: (invoice.paymentMode as string) ?? '',
      createdAt: (invoice.createdAt as string) ?? '',
      customer: customer && typeof customer.name === 'string' ? { id: customer.id, name: customer.name } : null,
    };
  });
  const paymentModes = raw.paymentModes.map((item) => {
    const mode = item as Record<string, unknown>;
    return { mode: (mode.mode as string) ?? '', amount: toNumber(mode.amount) };
  });
  return {
    businessDate: raw.businessDate as string,
    timezone: raw.timezone as string,
    failedSections: Array.isArray(raw.failedSections) ? (raw.failedSections as DashboardSummarySection[]) : [],
    todayGrossSales: toNullableNumber(raw.todayGrossSales),
    todayReturns: toNullableNumber(raw.todayReturns),
    todaySales: toNullableNumber(raw.todaySales),
    todayProfit: toNullableNumber(raw.todayProfit),
    todayOrders: toNullableNumber(raw.todayOrders),
    todayReturnCount: toNullableNumber(raw.todayReturnCount),
    totalRevenue: toNullableNumber(raw.totalRevenue),
    totalOrders: toNullableNumber(raw.totalOrders),
    totalCustomers: toNullableNumber(raw.totalCustomers),
    totalProducts: toNullableNumber(raw.totalProducts),
    outstandingUdhar: toNullableNumber(raw.outstandingUdhar),
    lowStockCount: toNullableNumber(raw.lowStockCount),
    outOfStockCount: toNullableNumber(raw.outOfStockCount),
    lowStockItems: Array.isArray(raw.lowStockItems) ? raw.lowStockItems.map(mapLowStockItem) : [],
    inventoryValue: toNullableNumber(raw.inventoryValue),
    recentInvoices,
    paymentModes,
    shift: mapDashboardShift(raw.shift),
  };
}

function mapDashboardKpis(payload: unknown): DashboardKpis {
  const raw = requireRecord(payload, 'GET /dashboard/kpis');
  return {
    businessDate: raw.businessDate as string,
    grossRevenue: toNumber(raw.grossRevenue),
    netRevenue: toNumber(raw.netRevenue),
    totalRefunds: toNumber(raw.totalRefunds),
    orders: toNumber(raw.orders),
    avgOrderValue: toNumber(raw.avgOrderValue),
  };
}

function mapTrend(data: unknown): TrendPoint[] {
  if (!Array.isArray(data) || data.some((item) => !isRecord(item) || typeof item.date !== 'string')) {
    throw new DashboardPayloadError('GET /dashboard/trends');
  }
  return data.map((item) => {
    const point = item as Record<string, unknown>;
    return { date: point.date as string, sales: toNumber(point.sales) };
  });
}

function mapLowStockList(payload: unknown): LowStockList {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new DashboardPayloadError('GET /dashboard/low-stock');
  return {
    lowStockCount: toNumber(payload.lowStockCount),
    outOfStockCount: toNumber(payload.outOfStockCount),
    items: payload.items.map(mapLowStockItem),
  };
}

function mapInsights(payload: unknown): DashboardInsights {
  const raw = requireRecord(payload, 'GET /dashboard/insights');
  const forecast = isRecord(raw.forecast) ? raw.forecast : null;
  const restock = isRecord(raw.restock) && Array.isArray(raw.restock.items) ? raw.restock : null;
  const top = isRecord(raw.topProduct) ? raw.topProduct : null;
  return {
    businessDate: raw.businessDate as string,
    generatedAt: (raw.generatedAt as string) ?? '',
    failedSections: Array.isArray(raw.failedSections) ? (raw.failedSections as InsightSection[]) : [],
    forecast: forecast
      ? {
          forecastNetRevenue: toNumber(forecast.forecastNetRevenue),
          basisDays: toNumber(forecast.basisDays),
          confidence: forecast.confidence === 'MEDIUM' ? 'MEDIUM' : 'LOW',
          basisFrom: (forecast.basisFrom as string) ?? '',
          basisTo: (forecast.basisTo as string) ?? '',
          todayNetSales: toNumber(forecast.todayNetSales),
          progressPct: toNullableNumber(forecast.progressPct),
        }
      : null,
    restock: restock
      ? {
          basisDays: toNumber(restock.basisDays),
          coverDays: toNumber(restock.coverDays),
          items: (restock.items as unknown[]).map((item) => {
            const row = isRecord(item) ? item : {};
            return {
              ...mapLowStockItem(row),
              avgDailyUnits: toNumber(row.avgDailyUnits),
              daysOfCover: toNullableNumber(row.daysOfCover),
              suggestedQuantity: toNumber(row.suggestedQuantity),
              urgency: row.urgency === 'OUT_OF_STOCK' || row.urgency === 'CRITICAL' ? row.urgency : 'LOW',
              reason: (row.reason as string) ?? '',
            } satisfies RestockSuggestion;
          }),
        }
      : null,
    topProduct: top
      ? {
          productId: (top.productId as string) ?? '',
          name: (top.name as string) ?? '',
          sku: (top.sku as string) ?? '',
          unitsSold: toNumber(top.unitsSold),
          netRevenue: toNumber(top.netRevenue),
          grossProfit: toNumber(top.grossProfit),
          grossMarginPct: toNumber(top.grossMarginPct),
        }
      : null,
  };
}

async function getDashboard<T>(url: string, map: (payload: unknown) => T): Promise<T> {
  const { data } = await apiClient.get<unknown>(url, { timeout: DASHBOARD_REQUEST_TIMEOUT_MS });
  return map(data);
}

/** Reads `filename="..."` from a Content-Disposition header, if present. */
function filenameFromDisposition(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

export const analyticsApi = {
  dashboardSummary: () => getDashboard('/dashboard/summary', mapDashboardSummary),

  /** `GET /dashboard/kpis` — live, cached server-side for 60 s. */
  kpis: () => getDashboard('/dashboard/kpis', mapDashboardKpis),

  revenueTrend: (days = 30) => getDashboard(`/dashboard/trends?days=${days}`, mapTrend),

  /** `GET /dashboard/low-stock` — every stock alert, out of stock first. */
  lowStock: (limit = 200) => getDashboard(`/dashboard/low-stock?limit=${limit}`, mapLowStockList),

  /** `GET /dashboard/insights` — forecast, restock suggestions, top product. */
  insights: () => getDashboard('/dashboard/insights', mapInsights),

  analyticsPage: (range: AnalyticsRange = 'week') =>
    get<AnalyticsPagePayload>(`/dashboard/analytics?range=${range}`),

  /**
   * `GET /dashboard/export/<kind>.csv?from&to` streamed as a blob through the
   * authenticated axios instance, then handed to the browser as a download.
   * `from` / `to` are ISO dates (YYYY-MM-DD), business-day inclusive.
   */
  exportCsv: async (kind: ExportKind, from: string, to: string): Promise<void> => {
    const response = await apiClient.get<Blob>(`/dashboard/export/${kind}.csv`, {
      params: { from, to },
      responseType: 'blob',
    });
    const blob =
      response.data instanceof Blob ? response.data : new Blob([response.data as BlobPart], { type: 'text/csv' });
    const filename = filenameFromDisposition(response.headers?.['content-disposition']) ?? `${kind}_${from}_to_${to}.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};

// ---------------------------------------------------------------------------
// Employees — API users mapped to the employees page shape
// ---------------------------------------------------------------------------
export interface EmployeeView {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  shift: string;
  salary: number;
  advance: number;
  status: 'On Shift' | 'Off Shift' | 'On Leave';
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  SUPER_ADMIN: 'Owner',
  ADMIN: 'Manager',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  VIEWER: 'Stock Clerk',
};

export const employeesApi = {
  list: () =>
    get<Array<Record<string, unknown>>>('/users/employees').then((users) =>
      users.map(
        (user): EmployeeView => ({
          id: user.id as string,
          name: user.name as string,
          email: (user.email as string) ?? '',
          role: ROLE_LABELS[(user.role as string) ?? ''] ?? 'Cashier',
          phone: (user.phone as string) ?? '',
          shift: 'General',
          // Payroll is not modelled in the backend yet.
          salary: 0,
          advance: 0,
          status: user.isActive === false ? 'On Leave' : 'Off Shift',
        }),
      ),
    ),
};

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
export interface SupplierView {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string | null;
  gstin: string | null;
  address: string | null;
  pendingPayables: number;
  lastDelivery: string | null;
  status: 'Active' | 'Inactive';
}

export const suppliersApi = {
  list: () => get<SupplierView[]>('/suppliers'),

  create: (data: {
    name: string;
    phone: string;
    contactPerson?: string;
    email?: string;
    gstin?: string;
    address?: string;
    openingBalance?: number;
  }) => post<SupplierView>('/suppliers', data),

  recordPayment: (id: string, amount: number) =>
    post<SupplierView>(`/suppliers/${id}/payments`, { amount }),

  update: (id: string, data: Record<string, unknown>) =>
    patch<SupplierView>(`/suppliers/${id}`, data),

  delete: (id: string) => del(`/suppliers/${id}`),
};

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export interface ExpenseView {
  id: string;
  description: string;
  category: string;
  amount: number;
  status: 'Paid' | 'Pending';
  mode: string;
  date: string;
}

export const expensesApi = {
  list: () => get<ExpenseView[]>('/expenses'),

  create: (data: {
    description: string;
    category: string;
    amount: number;
    isPaid?: boolean;
    paymentMode?: string;
    expenseDate?: string;
  }) => post<ExpenseView>('/expenses', data),

  update: (
    id: string,
    data: Partial<{
      description: string;
      category: string;
      amount: number;
      isPaid: boolean;
      paymentMode: string;
      expenseDate: string;
    }>,
  ) => patch<ExpenseView>(`/expenses/${id}`, data),

  delete: (id: string) => del(`/expenses/${id}`),
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export const notificationsApi = {
  list: () => get<NotificationView[]>('/notifications'),

  markRead: (id: string) => patch<NotificationView>(`/notifications/${id}/read`, {}),

  markAllRead: () => patch<{ updated: number }>('/notifications/read-all', {}),
};

// ===========================================================================
// POS / Billing (docs/POS_BILLING_CONTRACT.md) — owned by the POS front end.
// Mappers are pure; every Decimal string becomes a number for display only.
// ===========================================================================

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return (value && typeof value === 'object' ? value : {}) as Raw;
}

function asArray(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRaw) : [];
}

function posNamedRef(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Raw;
  return { id: (raw.id as string) ?? '', name: (raw.name as string) ?? '' };
}

// ---------------------------------------------------------------------------
// Search (products)
// ---------------------------------------------------------------------------
export function mapSearchResult(raw: Raw): SearchResult {
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? '',
    sku: (raw.sku as string) ?? '',
    barcode: (raw.barcode as string) ?? null,
    sellingPrice: toNumber(raw.sellingPrice ?? raw.price ?? raw.mrp),
    mrp: toNumber(raw.mrp ?? raw.sellingPrice),
    gstRate: (raw.gstRate as string) ?? 'EIGHTEEN',
    cessRate: toNumber(raw.cessRate),
    unit: (raw.unit as string) ?? 'PCS',
    currentStock: toNumber(raw.currentStock ?? raw.quantity),
    type: (raw.type as string) ?? 'SIMPLE',
    isActive: raw.isActive === undefined ? true : Boolean(raw.isActive),
    imageUrl: (raw.imageUrl as string) ?? null,
    categoryName:
      (raw.categoryName as string) ?? (raw.category as { name?: string } | undefined)?.name ?? null,
  };
}

/** Converts a full Product (from `GET /products`) into the lean POS grid shape. */
export function productToSearchResult(product: Product): SearchResult {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
    sellingPrice: product.sellingPrice ?? product.price,
    mrp: product.mrp ?? product.price,
    gstRate: product.gstRate ?? 'EIGHTEEN',
    cessRate: product.cessRate ?? 0,
    unit: product.unit ?? 'PCS',
    currentStock: product.currentStock ?? product.quantity,
    type: product.type ?? 'SIMPLE',
    isActive: product.isActive ?? true,
    imageUrl: product.image ?? null,
    categoryName: product.category ?? null,
  };
}

export const searchApi = {
  /** `GET /search?q&limit` — lean rows ranked by relevance. */
  search: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
    apiClient
      .get<unknown[]>(`/search${buildQuery({ q: query, limit: options?.limit ?? 30 })}`, {
        signal: options?.signal,
      })
      .then((res) => (Array.isArray(res.data) ? res.data : []).map((item) => mapSearchResult(asRaw(item)))),

  /** `GET /search/barcode/:code` — exactly one product, else 404 BARCODE_NOT_FOUND / 409 BARCODE_AMBIGUOUS. */
  barcode: (code: string) =>
    get<Raw>(`/search/barcode/${encodeURIComponent(code)}`).then((raw) => mapSearchResult(asRaw(raw))),
};

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------
function mapShopProfile(raw: Raw): ShopProfile {
  const settings = asRaw(raw.settings);
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? '',
    address: (raw.address as string) ?? null,
    city: (raw.city as string) ?? null,
    state: (raw.state as string) ?? null,
    pincode: (raw.pincode as string) ?? null,
    phone: (raw.phone as string) ?? null,
    email: (raw.email as string) ?? null,
    logoUrl: (raw.logoUrl as string) ?? null,
    settings: {
      gstin: (settings.gstin as string) ?? null,
      currency: (settings.currency as string) ?? 'INR',
      timezone: (settings.timezone as string) ?? 'Asia/Kolkata',
    },
  };
}

export const shopApi = {
  /** `GET /shops/me` */
  me: () => get<Raw>('/shops/me').then(mapShopProfile),
};

// ---------------------------------------------------------------------------
// Customers as the POS needs them (search / get / create only).
// The customers page owns `customersApi`; this section is deliberately separate.
// ---------------------------------------------------------------------------
export function mapPosCustomer(raw: Raw): PosCustomer {
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? '',
    phone: (raw.phone as string) ?? '',
    state: (raw.state as string) ?? null,
    creditLimit: toNumber(raw.creditLimit, 0),
    outstandingBalance: toNumber(raw.outstandingBalance ?? raw.udharAmount ?? raw.outstandingUdhar, 0),
  };
}

export const posCustomersApi = {
  /** `POST /customers/search { query, take }` — returns an array. */
  search: (query: string, options?: { take?: number; signal?: AbortSignal }) =>
    apiClient
      .post<unknown>('/customers/search', { query, take: options?.take ?? 8 }, { signal: options?.signal })
      .then((res) => {
        const data = res.data as unknown;
        const rows = Array.isArray(data) ? data : (asRaw(data).items as unknown[]) ?? [];
        return rows.map((row) => mapPosCustomer(asRaw(row)));
      }),

  /** `GET /customers/:id` */
  get: (id: string) => get<Raw>(`/customers/${id}`).then((raw) => mapPosCustomer(asRaw(raw))),

  /** `POST /customers` */
  create: (data: { name: string; phone: string; state?: string; email?: string; creditLimit?: number }) =>
    post<Raw>('/customers', data).then((raw) => mapPosCustomer(asRaw(raw))),
};

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
/** Catalogue product line (contract §2). */
export interface ProductLineRequest {
  productId: string;
  quantity: number;
  discountPercent?: number;
}

/** Ad-hoc line: priced and taxed as given, never merged, never touches stock (contract §2). */
export interface CustomLineRequest {
  custom: {
    name: string;
    unitPrice: number;
    gstRate: GstRate;
    unit?: ProductUnit;
  };
  quantity: number;
  discountPercent?: number;
}

/** Exactly one of `productId` / `custom` per item. */
export type InvoiceLineRequest = ProductLineRequest | CustomLineRequest;

export interface InvoicePaymentRequest {
  tender: TenderType;
  amount: number;
  tenderedAmount?: number;
  reference?: string;
}

export interface CreateInvoiceRequest {
  idempotencyKey: string;
  items: InvoiceLineRequest[];
  customerId?: string;
  notes?: string;
  shiftId?: string;
  discountAmount?: number;
  discountPercentage?: number;
  discountType?: 'FIXED_AMOUNT' | 'PERCENTAGE';
  discountReason?: string;
  payments: InvoicePaymentRequest[];
  udharAmount?: number;
}

export interface CalculateInvoiceRequest {
  items: InvoiceLineRequest[];
  customerId?: string;
  discountAmount?: number;
  discountPercentage?: number;
  discountType?: 'FIXED_AMOUNT' | 'PERCENTAGE';
  discountReason?: string;
}

export interface CreateReturnRequest {
  idempotencyKey: string;
  invoiceId: string;
  items?: Array<{ invoiceItemId: string; quantity: number }>;
  reason?: string;
  notes?: string;
  refund?: { tender?: TenderType; reference?: string };
}

export interface ListInvoicesParams {
  from?: string;
  to?: string;
  status?: InvoiceStatus | '';
  type?: InvoiceType | '';
  customerId?: string;
  paymentMode?: PaymentMode | '';
  q?: string;
  skip?: number;
  take?: number;
}

export function mapInvoiceSummary(raw: Raw): InvoiceSummary {
  const items = raw.items;
  return {
    id: raw.id as string,
    invoiceNumber: (raw.invoiceNumber as string) ?? '',
    type: ((raw.type as string) ?? 'SALE') as InvoiceType,
    status: ((raw.status as string) ?? 'COMPLETED') as InvoiceStatus,
    totalAmount: toNumber(raw.totalAmount),
    paidAmount: toNumber(raw.paidAmount),
    udharAmount: toNumber(raw.udharAmount),
    changeAmount: toNumber(raw.changeAmount),
    paymentMode: ((raw.paymentMode as string) ?? 'CASH') as PaymentMode,
    createdAt: (raw.createdAt as string) ?? '',
    customer: posNamedRef(raw.customer),
    cashier: posNamedRef(raw.cashier),
    itemCount: toNumber(raw.itemCount ?? (Array.isArray(items) ? items.length : 0)),
    originalId: (raw.originalId as string) ?? null,
    returnedAmount: toNumber(raw.returnedAmount),
  };
}

export function mapInvoicePayment(raw: Raw): InvoicePayment {
  return {
    id: (raw.id as string) ?? '',
    tender: ((raw.tender as string) ?? (raw.type as string) ?? 'CASH') as TenderType,
    amount: toNumber(raw.amount),
    tenderedAmount: toNullableNumber(raw.tenderedAmount),
    changeAmount: toNumber(raw.changeAmount),
    reference: (raw.reference as string) ?? null,
    createdAt: (raw.createdAt as string) ?? null,
  };
}

export function mapInvoiceItem(raw: Raw): InvoiceDetailItem {
  const cgst = toNumber(raw.cgstAmount);
  const sgst = toNumber(raw.sgstAmount);
  const igst = toNumber(raw.igstAmount);
  const cess = toNumber(raw.cessAmount);
  const productId = typeof raw.productId === 'string' && raw.productId ? raw.productId : null;
  return {
    id: (raw.id as string) ?? '',
    productId,
    // Receipt rows omit `productId`; only an explicit null (or the CUSTOM sku) marks an ad-hoc line.
    isCustom:
      raw.isCustom !== undefined ? Boolean(raw.isCustom) : 'productId' in raw ? productId === null : raw.productSku === 'CUSTOM',
    productName: (raw.productName as string) ?? (asRaw(raw.product).name as string) ?? '',
    productSku: (raw.productSku as string) ?? (asRaw(raw.product).sku as string) ?? '',
    quantity: toNumber(raw.quantity),
    unit: (raw.unit as string) ?? 'PCS',
    sellingPrice: toNumber(raw.sellingPrice ?? raw.unitPrice),
    mrp: toNumber(raw.mrp ?? raw.sellingPrice),
    discountPercent: toNumber(raw.discountPercent),
    discountAmount: toNumber(raw.discountAmount),
    taxableAmount: toNumber(raw.taxableAmount),
    gstRate: (raw.gstRate as string) ?? 'ZERO',
    cgstAmount: cgst,
    sgstAmount: sgst,
    igstAmount: igst,
    cessAmount: cess,
    // Server-stored tax parts; summed for display only (no invoice math here).
    taxAmount: raw.taxAmount !== undefined ? toNumber(raw.taxAmount) : cgst + sgst + igst + cess,
    totalAmount: toNumber(raw.totalAmount),
    returnedQuantity: toNumber(raw.returnedQuantity),
  };
}

export function mapInvoiceDetail(raw: Raw): InvoiceDetail {
  const customer = raw.customer && typeof raw.customer === 'object' ? asRaw(raw.customer) : null;
  const shift = raw.shift && typeof raw.shift === 'object' ? asRaw(raw.shift) : null;
  return {
    id: raw.id as string,
    invoiceNumber: (raw.invoiceNumber as string) ?? '',
    type: ((raw.type as string) ?? 'SALE') as InvoiceType,
    status: ((raw.status as string) ?? 'COMPLETED') as InvoiceStatus,
    originalId: (raw.originalId as string) ?? null,
    subtotal: toNumber(raw.subtotal),
    taxableAmount: toNumber(raw.taxableAmount),
    cgstAmount: toNumber(raw.cgstAmount),
    sgstAmount: toNumber(raw.sgstAmount),
    igstAmount: toNumber(raw.igstAmount),
    taxAmount: toNumber(raw.taxAmount),
    discountAmount: toNumber(raw.discountAmount),
    discountPercentage: toNullableNumber(raw.discountPercentage),
    discountType: (raw.discountType as string) ?? null,
    discountReason: (raw.discountReason as string) ?? null,
    roundOffAmount: toNumber(raw.roundOffAmount),
    totalAmount: toNumber(raw.totalAmount),
    paidAmount: toNumber(raw.paidAmount),
    udharAmount: toNumber(raw.udharAmount),
    changeAmount: toNumber(raw.changeAmount),
    paymentMode: ((raw.paymentMode as string) ?? 'CASH') as PaymentMode,
    paymentRef: (raw.paymentRef as string) ?? null,
    isInterState: Boolean(raw.isInterState),
    cancelReason: (raw.cancelReason as string) ?? null,
    cancelledAt: (raw.cancelledAt as string) ?? null,
    notes: (raw.notes as string) ?? null,
    shiftId: (raw.shiftId as string) ?? (shift?.id as string) ?? null,
    createdAt: (raw.createdAt as string) ?? '',
    customer: customer
      ? {
          id: (customer.id as string) ?? '',
          name: (customer.name as string) ?? '',
          phone: (customer.phone as string) ?? null,
          state: (customer.state as string) ?? null,
        }
      : null,
    cashier: posNamedRef(raw.cashier),
    shift: shift
      ? {
          id: (shift.id as string) ?? '',
          status: ((shift.status as string) ?? 'OPEN') as ShiftStatus,
          openedAt: (shift.openedAt as string) ?? null,
        }
      : null,
    items: asArray(raw.items).map(mapInvoiceItem),
    payments: asArray(raw.payments).map(mapInvoicePayment),
    returns: asArray(raw.returns ?? raw.returnInvoices).map(mapInvoiceSummary),
    originalInvoice:
      raw.originalInvoice && typeof raw.originalInvoice === 'object'
        ? mapInvoiceSummary(asRaw(raw.originalInvoice))
        : null,
  };
}

function mapReceiptGstRow(raw: Raw): ReceiptGstRow {
  return {
    rate: (raw.rate as string | number) ?? '',
    taxableAmount: toNumber(raw.taxableAmount),
    cgst: toNumber(raw.cgst),
    sgst: toNumber(raw.sgst),
    igst: toNumber(raw.igst),
    cess: toNumber(raw.cess),
  };
}

export function mapReceiptPayload(raw: Raw): ReceiptPayload {
  const shop = asRaw(raw.shop);
  const totals = asRaw(raw.totals);
  const invoice = mapInvoiceDetail(asRaw(raw.invoice));
  const items = Array.isArray(raw.items) ? asArray(raw.items).map(mapInvoiceItem) : invoice.items;
  const payments = Array.isArray(raw.payments) ? asArray(raw.payments).map(mapInvoicePayment) : invoice.payments;
  return {
    shop: {
      name: (shop.name as string) ?? '',
      address: (shop.address as string) ?? null,
      city: (shop.city as string) ?? null,
      state: (shop.state as string) ?? null,
      pincode: (shop.pincode as string) ?? null,
      phone: (shop.phone as string) ?? null,
      email: (shop.email as string) ?? null,
      gstin: (shop.gstin as string) ?? null,
    },
    invoice,
    items,
    payments,
    gstSummary: asArray(raw.gstSummary).map(mapReceiptGstRow),
    totals: {
      subtotal: toNumber(totals.subtotal ?? invoice.subtotal),
      discount: toNumber(totals.discount ?? invoice.discountAmount),
      taxable: toNumber(totals.taxable ?? invoice.taxableAmount),
      tax: toNumber(totals.tax ?? invoice.taxAmount),
      roundOff: toNumber(totals.roundOff ?? invoice.roundOffAmount),
      grandTotal: toNumber(totals.grandTotal ?? invoice.totalAmount),
      paid: toNumber(totals.paid ?? invoice.paidAmount),
      change: toNumber(totals.change ?? invoice.changeAmount),
      udhar: toNumber(totals.udhar ?? invoice.udharAmount),
    },
  };
}

function mapCreateInvoiceResponse(raw: Raw): CreateInvoiceResponse {
  // Legacy servers may return the bare invoice; tolerate both envelopes.
  const invoiceRaw = raw.invoice && typeof raw.invoice === 'object' ? asRaw(raw.invoice) : raw;
  return {
    invoice: mapInvoiceDetail(invoiceRaw),
    stock: asArray(raw.stock).map((row) => ({
      productId: (row.productId as string) ?? '',
      balanceAfter: toNumber(row.balanceAfter),
    })),
    shiftId: (raw.shiftId as string) ?? (invoiceRaw.shiftId as string) ?? null,
  };
}

export const billingApi = {
  /** `POST /billing/calculate` — server-side preview (engine result + inter-state flags). */
  calculate: (body: CalculateInvoiceRequest) => post<Raw>('/billing/calculate', body),

  /** `POST /billing/invoice` — idempotent; 200 on replay with the same payload. */
  createInvoice: (body: CreateInvoiceRequest, options?: { timeoutMs?: number }) =>
    apiClient
      .post<Raw>('/billing/invoice', body, { timeout: options?.timeoutMs ?? 20000 })
      .then((res) => mapCreateInvoiceResponse(asRaw(res.data))),

  /** `GET /billing/invoices?from&to&type&status&q&skip&take` → `{ items, total }` */
  listInvoices: (params: ListInvoicesParams, options?: { signal?: AbortSignal }) =>
    apiClient
      .get<unknown>(`/billing/invoices${buildQuery({ ...params })}`, { signal: options?.signal })
      .then((res) => {
        const data = res.data;
        const rows = Array.isArray(data) ? data : (asRaw(data).items as unknown[]) ?? [];
        const total = Array.isArray(data) ? data.length : toNumber(asRaw(data).total, rows.length);
        return { items: rows.map((row) => mapInvoiceSummary(asRaw(row))), total };
      }),

  /** `GET /billing/invoices/:id` */
  getInvoice: (id: string) => get<Raw>(`/billing/invoices/${id}`).then((raw) => mapInvoiceDetail(asRaw(raw))),

  /** `GET /billing/invoices/:id/receipt` */
  getReceipt: (id: string) =>
    get<Raw>(`/billing/invoices/${id}/receipt`).then((raw) => mapReceiptPayload(asRaw(raw))),

  /** `POST /billing/returns` → return invoice (type SALES_RETURN). */
  createReturn: (body: CreateReturnRequest) =>
    post<Raw>('/billing/returns', body).then((raw) => {
      const r = asRaw(raw);
      return mapInvoiceDetail(r.invoice && typeof r.invoice === 'object' ? asRaw(r.invoice) : r);
    }),

  /** `POST /billing/invoices/:id/cancel { reason }` (MANAGER+). */
  cancelInvoice: (id: string, reason: string) =>
    post<Raw>(`/billing/invoices/${id}/cancel`, { reason }).then((raw) => {
      const r = asRaw(raw);
      return mapInvoiceDetail(r.invoice && typeof r.invoice === 'object' ? asRaw(r.invoice) : r);
    }),
};

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------
export function mapShift(raw: Raw): Shift {
  return {
    id: raw.id as string,
    status: ((raw.status as string) ?? 'OPEN') as ShiftStatus,
    openedAt: (raw.openedAt as string) ?? (raw.createdAt as string) ?? '',
    closedAt: (raw.closedAt as string) ?? null,
    openingCash: toNumber(raw.openingCash),
    expectedCash: toNumber(raw.expectedCash),
    closingCash: toNullableNumber(raw.closingCash),
    variance: toNullableNumber(raw.variance),
    totalSales: toNumber(raw.totalSales),
    cashSales: toNumber(raw.cashSales),
    upiSales: toNumber(raw.upiSales),
    cardSales: toNumber(raw.cardSales),
    udharSales: toNumber(raw.udharSales),
    totalReceipts: toNumber(raw.totalReceipts),
    notes: (raw.notes as string) ?? null,
    openedBy: posNamedRef(raw.openedBy),
    closedBy: posNamedRef(raw.closedBy),
  };
}

export const shiftsApi = {
  /** `GET /shifts/current` → the caller's OPEN shift or null. */
  current: () =>
    get<unknown>('/shifts/current').then((data) =>
      data && typeof data === 'object' && (data as Raw).id ? mapShift(asRaw(data)) : null,
    ),

  /** `POST /shifts/open { openingCash }` (409 SHIFT_ALREADY_OPEN). */
  open: (openingCash: number) => post<Raw>('/shifts/open', { openingCash }).then((raw) => mapShift(asRaw(raw))),

  /** `POST /shifts/current/close { closingCash, notes? }` → includes expectedCash/closingCash/variance. */
  close: (data: { closingCash: number; notes?: string }) =>
    post<Raw>('/shifts/current/close', data).then((raw) => mapShift(asRaw(raw))),

  /** `GET /shifts?skip&take` */
  list: (params?: { skip?: number; take?: number }) =>
    get<unknown>(`/shifts${buildQuery({ skip: params?.skip, take: params?.take ?? 50 })}`).then((data) => {
      const rows = Array.isArray(data) ? data : (asRaw(data).items as unknown[]) ?? [];
      const total = Array.isArray(data) ? data.length : toNumber(asRaw(data).total, rows.length);
      return { items: rows.map((row) => mapShift(asRaw(row))), total };
    }),
};

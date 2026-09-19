export type User = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: 'admin' | 'manager' | 'cashier' | 'owner';
  shopId: string;
};

export type Shop = {
  id: string;
  name: string;
  location: string;
  owner: string;
  phone: string;
};

export type Product = {
  id: string;
  name: string;
  sku: string;
  price: number;
  cost: number;
  quantity: number;
  category: string;
  image?: string;
  description?: string;
  gstRate?: string;
  barcode?: string;
  isActive?: boolean;
  isDeleted?: boolean;
  trackInventory?: boolean;
  currentStock?: number;
  brand?: string;
  aliases?: string[];
  variants?: any[];
  tax?: number;
  /** ProductUnit enum value (PCS, KG, GM, LTR, ML, BOX, PACK, DOZEN, BUNDLE). */
  unit?: string;
  /** ProductType enum value (SIMPLE, VARIABLE, BUNDLE, COMBO, SERVICE, DIGITAL). */
  type?: string;
  mrp?: number;
  sellingPrice?: number;
  /** Cess percentage on the taxable amount (0 for most products). */
  cessRate?: number;
};

export type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  udharAmount: number;
  totalSpent: number;
  lastPurchase?: string;
  creditLimit?: number;
  joinedAt?: string;
};

export type Invoice = {
  id: string;
  invoiceNo: string;
  customerId: string;
  items: InvoiceItem[];
  subtotal: number;
  tax: number;
  total: number;
  paymentMethod: 'cash' | 'card' | 'upi' | 'udhar';
  status: 'draft' | 'completed' | 'paid' | 'pending';
  createdAt: string;
  dueDate?: string;
};

export type InvoiceItem = {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  total: number;
};

export type DashboardStats = {
  totalSales: number;
  totalProfit: number;
  totalUdhar: number;
  lowStockItems: number;
  todayOrders: number;
  topCustomers: Customer[];
};

export type SalesData = {
  date: string;
  sales: number;
};

export type AnalyticsData = {
  period: 'daily' | 'weekly' | 'monthly';
  sales: SalesData[];
  products: ProductSalesData[];
  customers: CustomerAnalytics[];
};

export type ProductSalesData = {
  id: string;
  name: string;
  sales: number;
  revenue: number;
  quantity: number;
};

export type CustomerAnalytics = {
  id: string;
  name: string;
  spent: number;
  frequency: number;
};

export type Notification = {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  createdAt: string;
  read: boolean;
};

export type Transaction = {
  id: string;
  invoiceNo: string;
  customerName: string;
  amount: number;
  method: string;
  status: string;
  timestamp: string;
};

// ---------------------------------------------------------------------------
// POS / Billing contract shapes (docs/POS_BILLING_CONTRACT.md)
// All money fields are numbers (coerced from Prisma Decimal strings in the API
// client). Display only — never do money math on these outside the engine.
// ---------------------------------------------------------------------------

export type TenderType = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER';
export type PaymentMode = 'CASH' | 'UPI' | 'CARD' | 'UDHAR' | 'SPLIT';
export type InvoiceType = 'SALE' | 'SALES_RETURN';
export type InvoiceStatus = 'DRAFT' | 'COMPLETED' | 'CANCELLED';
export type ShiftStatus = 'OPEN' | 'CLOSED';
export type DiscountType = 'FIXED_AMOUNT' | 'PERCENTAGE';
export type ProductUnit = 'PCS' | 'KG' | 'GM' | 'LTR' | 'ML' | 'BOX' | 'PACK' | 'DOZEN' | 'BUNDLE';
export type ProductType = 'SIMPLE' | 'VARIABLE' | 'BUNDLE' | 'COMBO' | 'SERVICE' | 'DIGITAL';
export type GstRate = 'ZERO' | 'FIVE' | 'TWELVE' | 'EIGHTEEN' | 'TWENTYEIGHT';

/** Lean product row from `GET /search`, `GET /search/barcode/:code` and the POS grid. */
export type SearchResult = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  sellingPrice: number;
  mrp: number;
  gstRate: string;
  /** Cess percentage on the taxable amount; the engine needs it for parity with the API. */
  cessRate: number;
  unit: string;
  currentStock: number;
  type: string;
  isActive: boolean;
  imageUrl: string | null;
  categoryName: string | null;
};

/** Customer as the POS needs it (credit fields included). */
export type PosCustomer = {
  id: string;
  name: string;
  phone: string;
  state: string | null;
  creditLimit: number;
  outstandingBalance: number;
};

export type ShopProfile = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  settings: {
    gstin: string | null;
    currency: string;
    timezone: string;
  };
};

export type InvoiceSummary = {
  id: string;
  invoiceNumber: string;
  type: InvoiceType;
  status: InvoiceStatus;
  totalAmount: number;
  paidAmount: number;
  udharAmount: number;
  changeAmount: number;
  paymentMode: PaymentMode;
  createdAt: string;
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string } | null;
  itemCount: number;
  originalId: string | null;
  returnedAmount: number;
};

export type InvoicePayment = {
  id: string;
  tender: TenderType;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
  reference: string | null;
  createdAt: string | null;
};

export type InvoiceDetailItem = {
  id: string;
  /** `null` for ad-hoc (custom) lines that were never a catalogue product. */
  productId: string | null;
  /** Custom lines never touch stock; `productSku` is `CUSTOM` for them. */
  isCustom: boolean;
  productName: string;
  productSku: string;
  quantity: number;
  unit: string;
  sellingPrice: number;
  mrp: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  gstRate: string;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
  totalAmount: number;
  returnedQuantity: number;
};

export type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  type: InvoiceType;
  status: InvoiceStatus;
  originalId: string | null;
  subtotal: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  discountAmount: number;
  discountPercentage: number | null;
  discountType: string | null;
  discountReason: string | null;
  roundOffAmount: number;
  totalAmount: number;
  paidAmount: number;
  udharAmount: number;
  changeAmount: number;
  paymentMode: PaymentMode;
  paymentRef: string | null;
  isInterState: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  notes: string | null;
  shiftId: string | null;
  createdAt: string;
  customer: { id: string; name: string; phone: string | null; state: string | null } | null;
  cashier: { id: string; name: string } | null;
  shift: { id: string; status: ShiftStatus; openedAt: string | null } | null;
  items: InvoiceDetailItem[];
  payments: InvoicePayment[];
  returns: InvoiceSummary[];
  originalInvoice: InvoiceSummary | null;
};

export type Shift = {
  id: string;
  status: ShiftStatus;
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
  notes: string | null;
  openedBy: { id: string; name: string } | null;
  closedBy: { id: string; name: string } | null;
};

export type ReceiptGstRow = {
  rate: string | number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
};

export type ReceiptPayload = {
  shop: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
    gstin: string | null;
  };
  invoice: InvoiceDetail;
  items: InvoiceDetailItem[];
  payments: InvoicePayment[];
  gstSummary: ReceiptGstRow[];
  totals: {
    subtotal: number;
    discount: number;
    taxable: number;
    tax: number;
    roundOff: number;
    grandTotal: number;
    paid: number;
    change: number;
    udhar: number;
  };
};

export type CreateInvoiceResponse = {
  invoice: InvoiceDetail;
  stock: Array<{ productId: string; balanceAfter: number }>;
  shiftId: string | null;
};

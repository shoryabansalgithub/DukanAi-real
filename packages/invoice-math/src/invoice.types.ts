import Decimal from 'decimal.js';

/** Physical tender used to settle part of an invoice. */
export type TenderType = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER';

/** Invoice-level payment mode persisted on the invoice row. */
export type InvoicePaymentMode = 'CASH' | 'UPI' | 'CARD' | 'UDHAR' | 'SPLIT';

export type DiscountType = 'FIXED_AMOUNT' | 'PERCENTAGE';

export type NumericInput = number | string | Decimal;

export interface InvoiceItemMathInput {
  productId: string;
  quantity: NumericInput;
  unitPrice: NumericInput;
  /** Line discount in percent (0-100). */
  discountPercent?: NumericInput;
  /** GST slab as the Prisma enum string: 'ZERO' | 'FIVE' | 'TWELVE' | 'EIGHTEEN' | 'TWENTYEIGHT'. */
  gstRateStr?: string;
  /** Explicit GST percentage; takes precedence over gstRateStr. */
  gstRate?: NumericInput;
  /** Cess percentage on the taxable amount (default 0). */
  cessRate?: NumericInput;
  isInterState: boolean;
}

export interface TenderInput {
  type: TenderType;
  /** Amount applied to the invoice. */
  amount: NumericInput;
  /** Cash handed over by the customer (CASH only). Defaults to `amount`. */
  tenderedAmount?: NumericInput;
  reference?: string;
}

export interface PaymentInput {
  tenders: TenderInput[];
  /** Amount left on the customer's credit (udhar). */
  udharAmount?: NumericInput;
}

export interface InvoiceMathInput {
  items: InvoiceItemMathInput[];
  discountAmount?: NumericInput;
  discountPercentage?: NumericInput;
  discountType?: DiscountType | string;
  discountReason?: string;
  /** Omit for a preview (no payment validation). */
  payment?: PaymentInput;
  /** @deprecated legacy fields; mapped onto `payment` when `payment` is absent. */
  paymentMode?: string;
  /** @deprecated */
  amountPaid?: NumericInput;
  /** @deprecated */
  udharAmount?: NumericInput;
}

export interface InvoiceLineResult {
  productId: string;
  quantity: Decimal;
  unitPrice: Decimal;
  lineSubtotal: Decimal;
  /** Item discount + allocated share of the invoice discount. */
  discountAmount: Decimal;
  itemDiscountAmount: Decimal;
  invoiceDiscountShare: Decimal;
  taxableAmount: Decimal;
  gstRate: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

export interface TenderResult {
  type: TenderType;
  amount: Decimal;
  tenderedAmount: Decimal;
  changeAmount: Decimal;
  reference?: string;
}

export interface PaymentResult {
  paidAmount: Decimal;
  udharAmount: Decimal;
  changeAmount: Decimal;
  paymentMode: InvoicePaymentMode;
  tenders: TenderResult[];
}

export interface InvoiceCalculationResultV1 {
  schemaVersion: number;
  engineVersion: string;
  calculationHash: string;
  lines: InvoiceLineResult[];
  subtotal: Decimal;
  totalItemDiscount: Decimal;
  invoiceDiscount: Decimal;
  totalDiscount: Decimal;
  taxableTotal: Decimal;
  totalCgst: Decimal;
  totalSgst: Decimal;
  totalIgst: Decimal;
  totalCess: Decimal;
  totalTax: Decimal;
  grandTotal: Decimal;
  roundOff: Decimal;
  finalTotal: Decimal;
  payment: PaymentResult | null;
}

export interface ReturnLineMathInput {
  /** Identifier echoed back (e.g. invoiceItemId). */
  lineRef: string;
  originalQuantity: NumericInput;
  quantity: NumericInput;
  unitPrice: NumericInput;
  discountAmount: NumericInput;
  taxableAmount: NumericInput;
  cgstAmount: NumericInput;
  sgstAmount: NumericInput;
  igstAmount: NumericInput;
  cessAmount?: NumericInput;
  totalAmount: NumericInput;
}

export interface ReturnMathInput {
  lines: ReturnLineMathInput[];
}

export interface ReturnLineResult {
  lineRef: string;
  quantity: Decimal;
  unitPrice: Decimal;
  lineSubtotal: Decimal;
  discountAmount: Decimal;
  taxableAmount: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

export interface ReturnCalculationResult {
  lines: ReturnLineResult[];
  subtotal: Decimal;
  totalDiscount: Decimal;
  taxableTotal: Decimal;
  totalCgst: Decimal;
  totalSgst: Decimal;
  totalIgst: Decimal;
  totalCess: Decimal;
  totalTax: Decimal;
  grandTotal: Decimal;
  roundOff: Decimal;
  finalTotal: Decimal;
}

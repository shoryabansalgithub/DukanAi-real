// Stable backend compatibility wrapper.
// This file is the official integration boundary for all backend billing
// modules. Do NOT implement any independent financial calculation logic here.

export {
  InvoiceMathEngine,
  InvoiceMathError,
  deriveInvoicePaymentMode,
  DISCOUNT_LIMITS,
  DISCOUNT_TYPES,
  TENDER_TYPES,
  TENDER_TO_PAYMENT_MODE,
  FULL_PAYMENT_MODES,
  CREDIT_PAYMENT_MODE,
  SPLIT_PAYMENT_MODE,
  GST_RATE_MAP,
  Decimal,
} from '@dukaanai/invoice-math';

export type {
  InvoiceMathInput,
  InvoiceItemMathInput,
  InvoiceLineResult,
  InvoiceCalculationResultV1,
  InvoiceCalculationResultV1 as InvoiceMathResult,
  PaymentInput,
  PaymentResult,
  TenderInput,
  TenderResult,
  TenderType as MathTenderType,
  InvoicePaymentMode,
  ReturnMathInput,
  ReturnLineMathInput,
  ReturnCalculationResult,
  InvoiceMathErrorCode,
} from '@dukaanai/invoice-math';

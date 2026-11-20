import { TenderType, InvoicePaymentMode } from './invoice.types';

export const DISCOUNT_LIMITS = {
  MAX_DISCOUNT_PERCENT: 100,
  MAX_DISCOUNT_AMOUNT: 99999999,
};

export const DISCOUNT_TYPES = {
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  PERCENTAGE: 'PERCENTAGE',
} as const;

export const TENDER_TYPES: readonly TenderType[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];

/** Invoice payment modes that map 1:1 to a single tender. */
export const FULL_PAYMENT_MODES: readonly string[] = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'];

export const CREDIT_PAYMENT_MODE = 'UDHAR';

export const SPLIT_PAYMENT_MODE = 'SPLIT';

/** Tender → invoice payment mode (the invoice enum has no BANK_TRANSFER). */
export const TENDER_TO_PAYMENT_MODE: Record<TenderType, InvoicePaymentMode> = {
  CASH: 'CASH',
  UPI: 'UPI',
  CARD: 'CARD',
  BANK_TRANSFER: 'CARD',
};

/** Money is stored with two decimals; quantities with three. */
export const MONEY_DP = 2;
export const QUANTITY_DP = 3;

/**
 * Storage limits of the invoice tables (Prisma `Decimal(10,2)` money and
 * `Decimal(10,3)` quantities). The engine rejects anything that would not
 * fit instead of letting the database truncate or fail mid-transaction.
 */
export const MONEY_MAX = '99999999.99';
export const QUANTITY_MAX = '9999999.999';

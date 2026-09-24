export type InvoiceMathErrorCode =
  | 'ERR_NEGATIVE_DISCOUNT'
  | 'ERR_DISCOUNT_EXCEEDS_SUBTOTAL'
  | 'ERR_MISSING_DISCOUNT_REASON'
  | 'ERR_DISCOUNT_LIMIT'
  | 'ERR_ZERO_SUBTOTAL_DISCOUNT'
  | 'ERR_INVALID_QUANTITY'
  | 'ERR_INVALID_PRICE'
  | 'ERR_INVALID_LINE_DISCOUNT'
  | 'ERR_UNKNOWN_GST_RATE'
  | 'ERR_DUPLICATE_LINE'
  | 'ERR_EMPTY_INVOICE'
  | 'ERR_INVALID_PAYMENT'
  | 'ERR_NEGATIVE_PAYMENT'
  | 'ERR_NEGATIVE_UDHAR'
  | 'ERR_PAYMENT_MISMATCH'
  | 'ERR_CHANGE_NOT_ALLOWED'
  | 'ERR_UNKNOWN_TENDER'
  | 'ERR_UNKNOWN_PAYMENT_MODE'
  | 'ERR_RETURN_QTY_EXCEEDS'
  | 'ERR_INVALID_RETURN_LINE'
  | 'ERR_AMOUNT_TOO_LARGE';

export class InvoiceMathError extends Error {
  public readonly code: InvoiceMathErrorCode;

  constructor(message: string, code: InvoiceMathErrorCode) {
    super(message);
    this.name = 'InvoiceMathError';
    this.code = code;
    Object.setPrototypeOf(this, InvoiceMathError.prototype);
  }
}

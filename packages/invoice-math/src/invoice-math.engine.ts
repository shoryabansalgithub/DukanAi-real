import { Decimal } from './decimal';
import {
  InvoiceMathInput,
  InvoiceLineResult,
  InvoiceCalculationResultV1,
  PaymentInput,
  PaymentResult,
  TenderResult,
  TenderType,
  InvoicePaymentMode,
  NumericInput,
  ReturnMathInput,
  ReturnCalculationResult,
  ReturnLineResult,
} from './invoice.types';
import {
  DISCOUNT_LIMITS,
  DISCOUNT_TYPES,
  TENDER_TYPES,
  TENDER_TO_PAYMENT_MODE,
  MONEY_DP,
  QUANTITY_DP,
  MONEY_MAX,
  QUANTITY_MAX,
} from './invoice.constants';
import { TaxCalculator, GST_RATE_MAP } from './tax';
import { InvoiceMathError } from './invoice-math.error';

const ENGINE_VERSION = '2.0.0';
const SCHEMA_VERSION = 2;

/** Deterministic (non-cryptographic) hash of the frozen input for audit trails. */
function generateHash(input: unknown): string {
  const str = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

function toDecimal(value: NumericInput | undefined, fallback = 0): Decimal {
  if (value === undefined || value === null || value === '') return new Decimal(fallback);
  try {
    const d = new Decimal(value as Decimal.Value);
    if (!d.isFinite()) throw new Error('not finite');
    return d;
  } catch {
    throw new InvoiceMathError(`Invalid numeric value: ${String(value)}`, 'ERR_INVALID_PAYMENT');
  }
}

function resolveGstRate(item: { gstRate?: NumericInput; gstRateStr?: string }): Decimal {
  if (item.gstRate !== undefined && item.gstRate !== null) {
    const rate = toDecimal(item.gstRate);
    if (rate.isNegative() || rate.greaterThan(100)) {
      throw new InvoiceMathError(`Invalid GST rate ${rate.toString()}`, 'ERR_UNKNOWN_GST_RATE');
    }
    return rate;
  }
  const key = item.gstRateStr ?? 'EIGHTEEN';
  const mapped = GST_RATE_MAP[key];
  if (mapped === undefined) {
    throw new InvoiceMathError(`Unknown GST rate "${key}"`, 'ERR_UNKNOWN_GST_RATE');
  }
  return new Decimal(mapped);
}

/**
 * Maps the legacy `{ paymentMode, amountPaid, udharAmount }` shape onto the
 * tender-based payment input. Returns undefined when neither is present
 * (preview mode).
 */
function normalisePayment(input: InvoiceMathInput): PaymentInput | undefined {
  if (input.payment) return input.payment;
  if (input.amountPaid === undefined || input.amountPaid === null) return undefined;

  const mode = (input.paymentMode ?? 'CASH').toUpperCase();
  const paid = toDecimal(input.amountPaid);
  const udhar = toDecimal(input.udharAmount);

  if (mode === 'UDHAR') {
    return { tenders: [], udharAmount: udhar.isZero() ? paid : udhar };
  }
  if (mode === 'SPLIT') {
    return { tenders: paid.isZero() ? [] : [{ type: 'CASH', amount: paid }], udharAmount: udhar };
  }
  if (TENDER_TYPES.includes(mode as TenderType)) {
    return { tenders: paid.isZero() ? [] : [{ type: mode as TenderType, amount: paid }], udharAmount: udhar };
  }
  throw new InvoiceMathError(`Unknown payment mode: ${mode}`, 'ERR_UNKNOWN_PAYMENT_MODE');
}

export function deriveInvoicePaymentMode(tenders: readonly { type: TenderType; amount: Decimal }[], udhar: Decimal): InvoicePaymentMode {
  const nonZero = tenders.filter((t) => t.amount.greaterThan(0));
  if (nonZero.length === 0) {
    return 'UDHAR';
  }
  if (udhar.greaterThan(0)) return 'SPLIT';
  const types = new Set(nonZero.map((t) => t.type));
  if (types.size > 1) return 'SPLIT';
  return TENDER_TO_PAYMENT_MODE[nonZero[0].type];
}

function settlePayment(payment: PaymentInput, finalTotal: Decimal): PaymentResult {
  const udhar = money(toDecimal(payment.udharAmount));
  if (udhar.isNegative()) {
    throw new InvoiceMathError('udharAmount cannot be negative.', 'ERR_NEGATIVE_UDHAR');
  }

  const tenders: TenderResult[] = (payment.tenders ?? []).map((t) => {
    if (!TENDER_TYPES.includes(t.type)) {
      throw new InvoiceMathError(`Unknown tender type: ${String(t.type)}`, 'ERR_UNKNOWN_TENDER');
    }
    const amount = money(toDecimal(t.amount));
    if (amount.isNegative()) {
      throw new InvoiceMathError('Tender amount cannot be negative.', 'ERR_NEGATIVE_PAYMENT');
    }
    if (amount.greaterThan(MONEY_MAX)) {
      throw new InvoiceMathError(`Tender amount exceeds the maximum of ${MONEY_MAX}.`, 'ERR_INVALID_PAYMENT');
    }
    const tendered = t.tenderedAmount === undefined || t.tenderedAmount === null ? amount : money(toDecimal(t.tenderedAmount));
    if (tendered.lessThan(amount)) {
      throw new InvoiceMathError('Tendered amount cannot be less than the amount applied.', 'ERR_INVALID_PAYMENT');
    }
    const change = tendered.minus(amount);
    if (change.greaterThan(0) && t.type !== 'CASH') {
      throw new InvoiceMathError('Change can only be given on cash tenders.', 'ERR_CHANGE_NOT_ALLOWED');
    }
    return { type: t.type, amount, tenderedAmount: tendered, changeAmount: change, reference: t.reference };
  });

  const paidAmount = tenders.reduce((acc, t) => acc.plus(t.amount), new Decimal(0));
  const changeAmount = tenders.reduce((acc, t) => acc.plus(t.changeAmount), new Decimal(0));

  if (!paidAmount.plus(udhar).equals(finalTotal)) {
    throw new InvoiceMathError(
      `Payment mismatch: paid (${paidAmount.toFixed(2)}) + credit (${udhar.toFixed(2)}) must equal the final total (${finalTotal.toFixed(2)}).`,
      'ERR_PAYMENT_MISMATCH',
    );
  }
  if (udhar.greaterThan(finalTotal)) {
    throw new InvoiceMathError('udharAmount cannot exceed the final total.', 'ERR_NEGATIVE_PAYMENT');
  }

  return {
    paidAmount,
    udharAmount: udhar,
    changeAmount,
    paymentMode: deriveInvoicePaymentMode(tenders, udhar),
    tenders,
  };
}

export class InvoiceMathEngine {
  /**
   * Calculates the exact financial state of an invoice.
   *
   * Order of operations (see CALCULATION_SPEC.md):
   *  1. line subtotal = unitPrice × quantity
   *  2. item discount = line subtotal × discountPercent (2 dp)
   *  3. invoice discount (fixed or % of the post-item-discount subtotal) is
   *     allocated proportionally across lines (2 dp, remainder on the last
   *     line with room)
   *  4. GST/CESS per line on the taxable amount (exclusive pricing, 2 dp)
   *  5. grand total = Σ taxable + Σ tax; round-off to the nearest rupee
   *  6. optional payment settlement: Σ tenders + udhar == final total
   */
  static calculate(rawInput: InvoiceMathInput): InvoiceCalculationResultV1 {
    const input = Object.freeze(JSON.parse(JSON.stringify(rawInput))) as InvoiceMathInput;

    if (!input.items || input.items.length === 0) {
      throw new InvoiceMathError('An invoice needs at least one line.', 'ERR_EMPTY_INVOICE');
    }

    const seen = new Set<string>();
    const pre = input.items.map((item) => {
      if (seen.has(item.productId)) {
        throw new InvoiceMathError(`Product ${item.productId} appears more than once.`, 'ERR_DUPLICATE_LINE');
      }
      seen.add(item.productId);

      const qty = toDecimal(item.quantity).toDecimalPlaces(QUANTITY_DP, Decimal.ROUND_HALF_UP);
      if (!qty.greaterThan(0)) {
        throw new InvoiceMathError(`Quantity for ${item.productId} must be greater than 0.`, 'ERR_INVALID_QUANTITY');
      }
      if (qty.greaterThan(QUANTITY_MAX)) {
        throw new InvoiceMathError(`Quantity for ${item.productId} exceeds the maximum of ${QUANTITY_MAX}.`, 'ERR_INVALID_QUANTITY');
      }
      const unitPrice = money(toDecimal(item.unitPrice));
      if (unitPrice.isNegative()) {
        throw new InvoiceMathError(`Unit price for ${item.productId} cannot be negative.`, 'ERR_INVALID_PRICE');
      }
      if (unitPrice.greaterThan(MONEY_MAX)) {
        throw new InvoiceMathError(`Unit price for ${item.productId} exceeds the maximum of ${MONEY_MAX}.`, 'ERR_INVALID_PRICE');
      }
      const discPct = toDecimal(item.discountPercent);
      if (discPct.isNegative() || discPct.greaterThan(100)) {
        throw new InvoiceMathError(`Line discount for ${item.productId} must be between 0 and 100.`, 'ERR_INVALID_LINE_DISCOUNT');
      }
      const gstRate = resolveGstRate(item);
      const cessRate = toDecimal(item.cessRate);

      const lineSubtotal = money(unitPrice.mul(qty));
      if (lineSubtotal.greaterThan(MONEY_MAX)) {
        throw new InvoiceMathError(`Line amount for ${item.productId} (${lineSubtotal.toFixed(2)}) exceeds the maximum of ${MONEY_MAX}.`, 'ERR_AMOUNT_TOO_LARGE');
      }
      const itemDiscount = money(lineSubtotal.mul(discPct).div(100));
      return {
        item,
        qty,
        unitPrice,
        gstRate,
        cessRate,
        lineSubtotal,
        itemDiscount,
        netSubtotal: lineSubtotal.minus(itemDiscount),
      };
    });

    const rawSubtotal = pre.reduce((acc, l) => acc.plus(l.lineSubtotal), new Decimal(0));
    const totalItemDiscount = pre.reduce((acc, l) => acc.plus(l.itemDiscount), new Decimal(0));
    const netSubtotal = rawSubtotal.minus(totalItemDiscount);

    // Invoice-level discount
    let invoiceDiscount = new Decimal(0);
    const discountType = (input.discountType ?? '').toUpperCase();
    if (discountType === DISCOUNT_TYPES.PERCENTAGE) {
      const pct = toDecimal(input.discountPercentage);
      if (pct.isNegative()) throw new InvoiceMathError('Invoice discount cannot be negative.', 'ERR_NEGATIVE_DISCOUNT');
      if (pct.greaterThan(DISCOUNT_LIMITS.MAX_DISCOUNT_PERCENT)) {
        throw new InvoiceMathError(`Discount exceeds ${DISCOUNT_LIMITS.MAX_DISCOUNT_PERCENT}%.`, 'ERR_DISCOUNT_LIMIT');
      }
      invoiceDiscount = money(netSubtotal.mul(pct).div(100));
    } else if (input.discountAmount !== undefined && input.discountAmount !== null) {
      invoiceDiscount = money(toDecimal(input.discountAmount));
    } else if (input.discountPercentage !== undefined && input.discountPercentage !== null && discountType === '') {
      // Percentage supplied without a type: treat as percentage for backward compatibility.
      const pct = toDecimal(input.discountPercentage);
      if (pct.isNegative()) throw new InvoiceMathError('Invoice discount cannot be negative.', 'ERR_NEGATIVE_DISCOUNT');
      invoiceDiscount = money(netSubtotal.mul(pct).div(100));
    }

    if (invoiceDiscount.isNegative()) {
      throw new InvoiceMathError('Invoice discount cannot be negative.', 'ERR_NEGATIVE_DISCOUNT');
    }
    if (invoiceDiscount.greaterThan(DISCOUNT_LIMITS.MAX_DISCOUNT_AMOUNT)) {
      throw new InvoiceMathError(`Discount exceeds maximum allowed amount of ${DISCOUNT_LIMITS.MAX_DISCOUNT_AMOUNT}.`, 'ERR_DISCOUNT_LIMIT');
    }
    if (invoiceDiscount.greaterThan(0)) {
      if (netSubtotal.isZero()) {
        throw new InvoiceMathError('Cannot apply an invoice discount to a zero-value invoice.', 'ERR_ZERO_SUBTOTAL_DISCOUNT');
      }
      if (invoiceDiscount.greaterThan(netSubtotal)) {
        throw new InvoiceMathError('Discount cannot exceed the invoice subtotal.', 'ERR_DISCOUNT_EXCEEDS_SUBTOTAL');
      }
      if (!input.discountReason || !input.discountReason.trim()) {
        throw new InvoiceMathError('Discount reason is required when a discount is applied.', 'ERR_MISSING_DISCOUNT_REASON');
      }
    }

    // Proportional allocation of the invoice discount over net line amounts.
    const shares: Decimal[] = pre.map(() => new Decimal(0));
    if (invoiceDiscount.greaterThan(0)) {
      let allocated = new Decimal(0);
      for (let i = 0; i < pre.length; i++) {
        const isLast = i === pre.length - 1;
        let share = isLast
          ? invoiceDiscount.minus(allocated)
          : money(invoiceDiscount.mul(pre[i].netSubtotal).div(netSubtotal));
        if (share.greaterThan(pre[i].netSubtotal)) share = pre[i].netSubtotal;
        shares[i] = share;
        allocated = allocated.plus(share);
      }
      // Fix-up: if capping left a remainder, push it onto lines with room.
      let remainder = invoiceDiscount.minus(allocated);
      for (let i = 0; i < pre.length && remainder.greaterThan(0); i++) {
        const room = pre[i].netSubtotal.minus(shares[i]);
        if (room.greaterThan(0)) {
          const add = Decimal.min(room, remainder);
          shares[i] = shares[i].plus(add);
          remainder = remainder.minus(add);
        }
      }
    }

    const lines: InvoiceLineResult[] = [];
    let subtotal = new Decimal(0);
    let totalDiscount = new Decimal(0);
    let taxableTotal = new Decimal(0);
    let totalCgst = new Decimal(0);
    let totalSgst = new Decimal(0);
    let totalIgst = new Decimal(0);
    let totalCess = new Decimal(0);
    let totalTax = new Decimal(0);

    pre.forEach((l, i) => {
      const discountAmount = l.itemDiscount.plus(shares[i]);
      const taxableAmount = money(l.lineSubtotal.minus(discountAmount));

      const tax = TaxCalculator.calculateTax({
        taxableAmount,
        gstRate: l.gstRate.toNumber(),
        cessRate: l.cessRate.toNumber(),
        isInterState: !!l.item.isInterState,
        mode: 'EXCLUSIVE',
      });

      const line: InvoiceLineResult = {
        productId: l.item.productId,
        quantity: l.qty,
        unitPrice: l.unitPrice,
        lineSubtotal: l.lineSubtotal,
        discountAmount,
        itemDiscountAmount: l.itemDiscount,
        invoiceDiscountShare: shares[i],
        taxableAmount,
        gstRate: l.gstRate,
        cgstAmount: tax.cgstAmount,
        sgstAmount: tax.sgstAmount,
        igstAmount: tax.igstAmount,
        cessAmount: tax.cessAmount,
        taxAmount: tax.totalTaxAmount,
        lineTotal: tax.totalAmount,
      };
      lines.push(line);

      subtotal = subtotal.plus(line.lineSubtotal);
      totalDiscount = totalDiscount.plus(line.discountAmount);
      taxableTotal = taxableTotal.plus(line.taxableAmount);
      totalCgst = totalCgst.plus(line.cgstAmount);
      totalSgst = totalSgst.plus(line.sgstAmount);
      totalIgst = totalIgst.plus(line.igstAmount);
      totalCess = totalCess.plus(line.cessAmount);
      totalTax = totalTax.plus(line.taxAmount);
    });

    const grandTotal = taxableTotal.plus(totalTax);
    const roundedTotal = grandTotal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const roundOff = money(roundedTotal.minus(grandTotal));
    const finalTotal = grandTotal.plus(roundOff);
    if (subtotal.greaterThan(MONEY_MAX) || finalTotal.greaterThan(MONEY_MAX)) {
      throw new InvoiceMathError(`Invoice total ${finalTotal.toFixed(2)} exceeds the maximum of ${MONEY_MAX}.`, 'ERR_AMOUNT_TOO_LARGE');
    }

    const paymentInput = normalisePayment(input);
    const payment = paymentInput ? settlePayment(paymentInput, finalTotal) : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      calculationHash: generateHash(input),
      lines,
      subtotal,
      totalItemDiscount,
      invoiceDiscount,
      totalDiscount,
      taxableTotal,
      totalCgst,
      totalSgst,
      totalIgst,
      totalCess,
      totalTax,
      grandTotal,
      roundOff,
      finalTotal,
      payment,
    };
  }

  /**
   * Proportional return math. Each line's stored amounts are scaled by
   * quantity / originalQuantity (2 dp). Returning the full original quantity
   * reproduces the stored amounts exactly.
   */
  static calculateReturn(rawInput: ReturnMathInput): ReturnCalculationResult {
    const input = Object.freeze(JSON.parse(JSON.stringify(rawInput))) as ReturnMathInput;
    if (!input.lines || input.lines.length === 0) {
      throw new InvoiceMathError('A return needs at least one line.', 'ERR_EMPTY_INVOICE');
    }

    const lines: ReturnLineResult[] = input.lines.map((l) => {
      const originalQty = toDecimal(l.originalQuantity);
      const qty = toDecimal(l.quantity).toDecimalPlaces(QUANTITY_DP, Decimal.ROUND_HALF_UP);
      if (!originalQty.greaterThan(0)) {
        throw new InvoiceMathError(`Invalid original quantity on ${l.lineRef}.`, 'ERR_INVALID_RETURN_LINE');
      }
      if (!qty.greaterThan(0)) {
        throw new InvoiceMathError(`Return quantity on ${l.lineRef} must be greater than 0.`, 'ERR_INVALID_QUANTITY');
      }
      if (qty.greaterThan(originalQty)) {
        throw new InvoiceMathError(`Return quantity on ${l.lineRef} exceeds the original quantity.`, 'ERR_RETURN_QTY_EXCEEDS');
      }
      const full = qty.equals(originalQty);
      const ratio = qty.div(originalQty);
      const scale = (v: NumericInput | undefined) => {
        const d = money(toDecimal(v));
        return full ? d : money(d.mul(ratio));
      };

      const unitPrice = money(toDecimal(l.unitPrice));
      const lineSubtotal = money(unitPrice.mul(qty));
      const discountAmount = scale(l.discountAmount);
      const taxableAmount = scale(l.taxableAmount);
      const cgstAmount = scale(l.cgstAmount);
      const sgstAmount = scale(l.sgstAmount);
      const igstAmount = scale(l.igstAmount);
      const cessAmount = scale(l.cessAmount);
      const taxAmount = cgstAmount.plus(sgstAmount).plus(igstAmount).plus(cessAmount);
      const lineTotal = taxableAmount.plus(taxAmount);

      return {
        lineRef: l.lineRef,
        quantity: qty,
        unitPrice,
        lineSubtotal,
        discountAmount,
        taxableAmount,
        cgstAmount,
        sgstAmount,
        igstAmount,
        cessAmount,
        taxAmount,
        lineTotal,
      };
    });

    const sum = (pick: (l: ReturnLineResult) => Decimal) => lines.reduce((acc, l) => acc.plus(pick(l)), new Decimal(0));
    const subtotal = sum((l) => l.lineSubtotal);
    const totalDiscount = sum((l) => l.discountAmount);
    const taxableTotal = sum((l) => l.taxableAmount);
    const totalCgst = sum((l) => l.cgstAmount);
    const totalSgst = sum((l) => l.sgstAmount);
    const totalIgst = sum((l) => l.igstAmount);
    const totalCess = sum((l) => l.cessAmount);
    const totalTax = sum((l) => l.taxAmount);
    const grandTotal = taxableTotal.plus(totalTax);
    const roundedTotal = grandTotal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const roundOff = money(roundedTotal.minus(grandTotal));
    const finalTotal = grandTotal.plus(roundOff);

    return {
      lines,
      subtotal,
      totalDiscount,
      taxableTotal,
      totalCgst,
      totalSgst,
      totalIgst,
      totalCess,
      totalTax,
      grandTotal,
      roundOff,
      finalTotal,
    };
  }
}

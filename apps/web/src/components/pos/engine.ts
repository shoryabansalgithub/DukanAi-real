import { InvoiceMathEngine, InvoiceMathError } from '@dukaanai/invoice-math';
import type {
  InvoiceCalculationResultV1,
  InvoiceMathInput,
  PaymentInput,
  ReturnCalculationResult,
  ReturnMathInput,
} from '@dukaanai/invoice-math';
import type { CartDiscount, CartLine } from '@/store/pos';
import type { InvoiceDetailItem, PaymentMode, TenderType } from '@/types';

// ---------------------------------------------------------------------------
// The only place the web app talks to the shared math engine. Every rupee shown
// on the POS comes out of here; the adapter converts Decimal results to plain
// numbers for display and never performs money arithmetic itself.
// ---------------------------------------------------------------------------

type DecimalLike = { toString(): string };

function toMoney(value: DecimalLike | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface EngineLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  discountAmount: number;
  itemDiscountAmount: number;
  invoiceDiscountShare: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface EngineTender {
  type: TenderType;
  amount: number;
  tenderedAmount: number;
  changeAmount: number;
  reference?: string;
}

export interface EnginePayment {
  paidAmount: number;
  udharAmount: number;
  changeAmount: number;
  paymentMode: PaymentMode;
  tenders: EngineTender[];
}

export interface EngineTotals {
  lines: EngineLine[];
  /** Keyed by productId for O(1) cart-row lookups. */
  byProductId: Record<string, EngineLine>;
  subtotal: number;
  totalItemDiscount: number;
  invoiceDiscount: number;
  totalDiscount: number;
  taxableTotal: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
  totalTax: number;
  grandTotal: number;
  roundOff: number;
  finalTotal: number;
  payment: EnginePayment | null;
  calculationHash: string;
}

export interface EngineError {
  code: string;
  message: string;
}

export type EngineOutcome = { ok: true; totals: EngineTotals } | { ok: false; error: EngineError };

export interface TenderSpec {
  type: TenderType;
  amount: number;
  tenderedAmount?: number;
  reference?: string;
}

export interface PaymentSpec {
  tenders: TenderSpec[];
  udharAmount?: number;
}

function mapResult(result: InvoiceCalculationResultV1): EngineTotals {
  const lines: EngineLine[] = result.lines.map((line) => ({
    productId: line.productId,
    quantity: toMoney(line.quantity),
    unitPrice: toMoney(line.unitPrice),
    lineSubtotal: toMoney(line.lineSubtotal),
    discountAmount: toMoney(line.discountAmount),
    itemDiscountAmount: toMoney(line.itemDiscountAmount),
    invoiceDiscountShare: toMoney(line.invoiceDiscountShare),
    taxableAmount: toMoney(line.taxableAmount),
    cgstAmount: toMoney(line.cgstAmount),
    sgstAmount: toMoney(line.sgstAmount),
    igstAmount: toMoney(line.igstAmount),
    cessAmount: toMoney(line.cessAmount),
    taxAmount: toMoney(line.taxAmount),
    lineTotal: toMoney(line.lineTotal),
  }));
  const byProductId: Record<string, EngineLine> = {};
  lines.forEach((line) => {
    byProductId[line.productId] = line;
  });
  const payment = result.payment
    ? {
        paidAmount: toMoney(result.payment.paidAmount),
        udharAmount: toMoney(result.payment.udharAmount),
        changeAmount: toMoney(result.payment.changeAmount),
        paymentMode: result.payment.paymentMode as PaymentMode,
        tenders: result.payment.tenders.map((t) => ({
          type: t.type as TenderType,
          amount: toMoney(t.amount),
          tenderedAmount: toMoney(t.tenderedAmount),
          changeAmount: toMoney(t.changeAmount),
          reference: t.reference,
        })),
      }
    : null;
  return {
    lines,
    byProductId,
    subtotal: toMoney(result.subtotal),
    totalItemDiscount: toMoney(result.totalItemDiscount),
    invoiceDiscount: toMoney(result.invoiceDiscount),
    totalDiscount: toMoney(result.totalDiscount),
    taxableTotal: toMoney(result.taxableTotal),
    totalCgst: toMoney(result.totalCgst),
    totalSgst: toMoney(result.totalSgst),
    totalIgst: toMoney(result.totalIgst),
    totalCess: toMoney(result.totalCess),
    totalTax: toMoney(result.totalTax),
    grandTotal: toMoney(result.grandTotal),
    roundOff: toMoney(result.roundOff),
    finalTotal: toMoney(result.finalTotal),
    payment,
    calculationHash: result.calculationHash,
  };
}

function toEngineError(error: unknown): EngineError {
  if (error instanceof InvoiceMathError) {
    return { code: error.code, message: error.message };
  }
  const maybe = error as { code?: unknown; message?: unknown };
  if (maybe && typeof maybe.message === 'string') {
    return { code: typeof maybe.code === 'string' ? maybe.code : 'ERR_MATH', message: maybe.message };
  }
  return { code: 'ERR_MATH', message: 'The invoice could not be calculated.' };
}

export interface BuildInputOptions {
  lines: CartLine[];
  discount: CartDiscount;
  isInterState: boolean;
  payment?: PaymentSpec;
}

/** Builds the contract §1 engine input from the cart. */
export function buildEngineInput({ lines, discount, isInterState, payment }: BuildInputOptions): InvoiceMathInput {
  const input: InvoiceMathInput = {
    items: lines.map((line) => ({
      // Custom lines carry `custom:<lineId>` so each is a distinct engine key.
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent || undefined,
      gstRateStr: line.gstRate || 'EIGHTEEN',
      // Custom lines never carry cess (contract §2); products pass theirs through for parity with the API.
      cessRate: line.isCustom ? 0 : line.cessRate || 0,
      isInterState,
    })),
  };
  if (discount.value > 0) {
    input.discountType = discount.type;
    if (discount.type === 'PERCENTAGE') input.discountPercentage = discount.value;
    else input.discountAmount = discount.value;
    if (discount.reason.trim()) input.discountReason = discount.reason.trim();
  }
  if (payment) {
    const paymentInput: PaymentInput = {
      tenders: payment.tenders.map((t) => ({
        type: t.type,
        amount: t.amount,
        tenderedAmount: t.tenderedAmount,
        reference: t.reference || undefined,
      })),
    };
    if (payment.udharAmount && payment.udharAmount > 0) paymentInput.udharAmount = payment.udharAmount;
    input.payment = paymentInput;
  }
  return input;
}

/** Preview (no `payment`) or full settlement calculation; never throws. */
export function calculateCart(options: BuildInputOptions): EngineOutcome {
  if (options.lines.length === 0) {
    return { ok: true, totals: EMPTY_TOTALS };
  }
  try {
    const result = InvoiceMathEngine.calculate(buildEngineInput(options));
    return { ok: true, totals: mapResult(result) };
  } catch (error) {
    return { ok: false, error: toEngineError(error) };
  }
}

export const EMPTY_TOTALS: EngineTotals = {
  lines: [],
  byProductId: {},
  subtotal: 0,
  totalItemDiscount: 0,
  invoiceDiscount: 0,
  totalDiscount: 0,
  taxableTotal: 0,
  totalCgst: 0,
  totalSgst: 0,
  totalIgst: 0,
  totalCess: 0,
  totalTax: 0,
  grandTotal: 0,
  roundOff: 0,
  finalTotal: 0,
  payment: null,
  calculationHash: '',
};

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export interface ReturnPreviewLine {
  lineRef: string;
  quantity: number;
  lineSubtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface ReturnPreview {
  lines: ReturnPreviewLine[];
  byLineRef: Record<string, ReturnPreviewLine>;
  subtotal: number;
  totalDiscount: number;
  taxableTotal: number;
  totalTax: number;
  grandTotal: number;
  roundOff: number;
  finalTotal: number;
}

export type ReturnOutcome = { ok: true; preview: ReturnPreview } | { ok: false; error: EngineError };

function mapReturnResult(result: ReturnCalculationResult): ReturnPreview {
  const lines = result.lines.map((line) => ({
    lineRef: line.lineRef,
    quantity: toMoney(line.quantity),
    lineSubtotal: toMoney(line.lineSubtotal),
    discountAmount: toMoney(line.discountAmount),
    taxableAmount: toMoney(line.taxableAmount),
    taxAmount: toMoney(line.taxAmount),
    lineTotal: toMoney(line.lineTotal),
  }));
  const byLineRef: Record<string, ReturnPreviewLine> = {};
  lines.forEach((line) => {
    byLineRef[line.lineRef] = line;
  });
  return {
    lines,
    byLineRef,
    subtotal: toMoney(result.subtotal),
    totalDiscount: toMoney(result.totalDiscount),
    taxableTotal: toMoney(result.taxableTotal),
    totalTax: toMoney(result.totalTax),
    grandTotal: toMoney(result.grandTotal),
    roundOff: toMoney(result.roundOff),
    finalTotal: toMoney(result.finalTotal),
  };
}

/**
 * Proportional refund preview for a partial return, from the stored invoice
 * item amounts and the quantities being returned (contract §1 `calculateReturn`).
 */
export function calculateReturnPreview(
  items: InvoiceDetailItem[],
  quantities: Record<string, number>,
): ReturnOutcome {
  const lines: ReturnMathInput['lines'] = items
    .filter((item) => (quantities[item.id] ?? 0) > 0)
    .map((item) => ({
      lineRef: item.id,
      originalQuantity: item.quantity,
      quantity: quantities[item.id],
      unitPrice: item.sellingPrice,
      discountAmount: item.discountAmount,
      taxableAmount: item.taxableAmount,
      cgstAmount: item.cgstAmount,
      sgstAmount: item.sgstAmount,
      igstAmount: item.igstAmount,
      cessAmount: item.cessAmount,
      totalAmount: item.totalAmount,
    }));
  if (lines.length === 0) {
    return {
      ok: true,
      preview: {
        lines: [],
        byLineRef: {},
        subtotal: 0,
        totalDiscount: 0,
        taxableTotal: 0,
        totalTax: 0,
        grandTotal: 0,
        roundOff: 0,
        finalTotal: 0,
      },
    };
  }
  try {
    return { ok: true, preview: mapReturnResult(InvoiceMathEngine.calculateReturn({ lines })) };
  } catch (error) {
    return { ok: false, error: toEngineError(error) };
  }
}

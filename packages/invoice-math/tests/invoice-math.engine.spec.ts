import { InvoiceMathEngine } from '../src/invoice-math.engine';
import { InvoiceMathError } from '../src/invoice-math.error';

const line = (overrides: Partial<Parameters<typeof InvoiceMathEngine.calculate>[0]['items'][number]> = {}) => ({
  productId: '1',
  quantity: 1,
  unitPrice: 100,
  isInterState: false,
  gstRateStr: 'EIGHTEEN',
  ...overrides,
});

describe('InvoiceMathEngine.calculate', () => {
  it('single item, CGST/SGST split', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line()],
      payment: { tenders: [{ type: 'CASH', amount: 118 }] },
    });
    expect(result.subtotal.toNumber()).toBe(100);
    expect(result.totalCgst.toNumber()).toBe(9);
    expect(result.totalSgst.toNumber()).toBe(9);
    expect(result.totalIgst.toNumber()).toBe(0);
    expect(result.totalTax.toNumber()).toBe(18);
    expect(result.grandTotal.toNumber()).toBe(118);
    expect(result.payment?.paymentMode).toBe('CASH');
    expect(result.payment?.changeAmount.toNumber()).toBe(0);
  });

  it('inter-state uses IGST only', () => {
    const result = InvoiceMathEngine.calculate({ items: [line({ isInterState: true })] });
    expect(result.totalIgst.toNumber()).toBe(18);
    expect(result.totalCgst.toNumber()).toBe(0);
    expect(result.payment).toBeNull();
  });

  it('multiple GST slabs', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ productId: '1', gstRateStr: 'FIVE' }), line({ productId: '2', gstRateStr: 'TWELVE' })],
    });
    expect(result.totalTax.toNumber()).toBe(17);
    expect(result.grandTotal.toNumber()).toBe(217);
  });

  it('cess is added on top of GST', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'TWENTYEIGHT', cessRate: 12 })],
    });
    expect(result.totalCess.toNumber()).toBe(12);
    expect(result.totalTax.toNumber()).toBe(40);
    expect(result.finalTotal.toNumber()).toBe(140);
  });

  it('proportional invoice discount allocates exactly and keeps the invariant', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ productId: '1', gstRateStr: 'FIVE' }), line({ productId: '2', gstRateStr: 'TWELVE' })],
      discountAmount: 20,
      discountReason: 'Loyalty',
    });
    expect(result.totalDiscount.toNumber()).toBe(20);
    expect(result.taxableTotal.toNumber()).toBe(180);
    expect(result.lines[0].taxAmount.toNumber()).toBe(4.5);
    expect(result.lines[1].taxAmount.toNumber()).toBe(10.8);
    expect(result.grandTotal.toNumber()).toBe(195.3);
    expect(result.roundOff.toNumber()).toBe(-0.3);
    expect(result.finalTotal.toNumber()).toBe(195);
    // subtotal - discount + tax + roundOff == finalTotal
    expect(result.subtotal.minus(result.totalDiscount).plus(result.totalTax).plus(result.roundOff).toNumber()).toBe(195);
    // sum of line shares equals the invoice discount
    const shares = result.lines.reduce((acc, l) => acc + l.invoiceDiscountShare.toNumber(), 0);
    expect(shares).toBe(20);
  });

  it('percentage discount applies to the net (post item discount) subtotal', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ discountPercent: 10, gstRateStr: 'ZERO' })],
      discountType: 'PERCENTAGE',
      discountPercentage: 10,
      discountReason: 'Promo',
    });
    expect(result.totalItemDiscount.toNumber()).toBe(10);
    expect(result.invoiceDiscount.toNumber()).toBe(9);
    expect(result.taxableTotal.toNumber()).toBe(81);
  });

  it('uneven allocation never exceeds a line and sums exactly', () => {
    const result = InvoiceMathEngine.calculate({
      items: [
        line({ productId: 'a', unitPrice: 33.33, gstRateStr: 'ZERO' }),
        line({ productId: 'b', unitPrice: 33.33, gstRateStr: 'ZERO' }),
        line({ productId: 'c', unitPrice: 33.34, gstRateStr: 'ZERO' }),
      ],
      discountAmount: 10,
      discountReason: 'x',
    });
    const shares = result.lines.map((l) => l.invoiceDiscountShare.toNumber());
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10);
    expect(result.taxableTotal.toNumber()).toBe(90);
  });

  it('round-off to the nearest rupee', () => {
    const result = InvoiceMathEngine.calculate({ items: [line({ unitPrice: 100.4, gstRateStr: 'ZERO' })] });
    expect(result.roundOff.toNumber()).toBe(-0.4);
    expect(result.finalTotal.toNumber()).toBe(100);
    const up = InvoiceMathEngine.calculate({ items: [line({ unitPrice: 100.5, gstRateStr: 'ZERO' })] });
    expect(up.roundOff.toNumber()).toBe(0.5);
    expect(up.finalTotal.toNumber()).toBe(101);
  });

  it('decimal quantities (weighed goods)', () => {
    const result = InvoiceMathEngine.calculate({ items: [line({ quantity: 1.25, unitPrice: 80, gstRateStr: 'ZERO' })] });
    expect(result.subtotal.toNumber()).toBe(100);
  });

  it('cash with change', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'ZERO' })],
      payment: { tenders: [{ type: 'CASH', amount: 100, tenderedAmount: 500 }] },
    });
    expect(result.payment?.changeAmount.toNumber()).toBe(400);
    expect(result.payment?.paidAmount.toNumber()).toBe(100);
    expect(result.payment?.paymentMode).toBe('CASH');
  });

  it('split tenders plus credit derive SPLIT', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'ZERO' })],
      payment: { tenders: [{ type: 'CASH', amount: 40 }, { type: 'UPI', amount: 30, reference: 'UPI123' }], udharAmount: 30 },
    });
    expect(result.payment?.paymentMode).toBe('SPLIT');
    expect(result.payment?.udharAmount.toNumber()).toBe(30);
    expect(result.payment?.tenders[1].reference).toBe('UPI123');
  });

  it('pure credit derives UDHAR', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'ZERO' })],
      payment: { tenders: [], udharAmount: 100 },
    });
    expect(result.payment?.paymentMode).toBe('UDHAR');
    expect(result.payment?.paidAmount.toNumber()).toBe(0);
  });

  it('bank transfer maps to CARD mode', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'ZERO' })],
      payment: { tenders: [{ type: 'BANK_TRANSFER', amount: 100 }] },
    });
    expect(result.payment?.paymentMode).toBe('CARD');
  });

  it('legacy paymentMode/amountPaid input still settles', () => {
    const result = InvoiceMathEngine.calculate({
      items: [line({ gstRateStr: 'ZERO' })],
      paymentMode: 'SPLIT',
      amountPaid: 60,
      udharAmount: 40,
    });
    expect(result.payment?.paymentMode).toBe('SPLIT');
    expect(result.payment?.paidAmount.toNumber()).toBe(60);
  });

  const expectCode = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(InvoiceMathError);
      expect((e as InvoiceMathError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${code}`);
  };

  it('rejects payment mismatch', () => {
    expectCode(
      () => InvoiceMathEngine.calculate({ items: [line({ gstRateStr: 'ZERO' })], payment: { tenders: [{ type: 'CASH', amount: 90 }] } }),
      'ERR_PAYMENT_MISMATCH',
    );
  });

  it('rejects change on non-cash tenders', () => {
    expectCode(
      () =>
        InvoiceMathEngine.calculate({
          items: [line({ gstRateStr: 'ZERO' })],
          payment: { tenders: [{ type: 'UPI', amount: 100, tenderedAmount: 120 }] },
        }),
      'ERR_CHANGE_NOT_ALLOWED',
    );
  });

  it('rejects discount over subtotal, negative discount, missing reason', () => {
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ gstRateStr: 'ZERO' })], discountAmount: 110, discountReason: 'x' }), 'ERR_DISCOUNT_EXCEEDS_SUBTOTAL');
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ gstRateStr: 'ZERO' })], discountAmount: -10 }), 'ERR_NEGATIVE_DISCOUNT');
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ gstRateStr: 'ZERO' })], discountAmount: 20 }), 'ERR_MISSING_DISCOUNT_REASON');
  });

  it('rejects zero/negative quantity, duplicate lines, unknown GST rate, empty invoice', () => {
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ quantity: 0 })] }), 'ERR_INVALID_QUANTITY');
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ quantity: -1 })] }), 'ERR_INVALID_QUANTITY');
    expectCode(() => InvoiceMathEngine.calculate({ items: [line(), line()] }), 'ERR_DUPLICATE_LINE');
    expectCode(() => InvoiceMathEngine.calculate({ items: [line({ gstRateStr: 'FORTY' })] }), 'ERR_UNKNOWN_GST_RATE');
    expectCode(() => InvoiceMathEngine.calculate({ items: [] }), 'ERR_EMPTY_INVOICE');
  });

  it('rejects amounts and quantities that do not fit the invoice columns', () => {
    expect(() => InvoiceMathEngine.calculate({ items: [line({ quantity: 1_000_000, unitPrice: 100 })] })).toThrow(
      expect.objectContaining({ code: 'ERR_AMOUNT_TOO_LARGE' }),
    );
    expect(() => InvoiceMathEngine.calculate({ items: [line({ quantity: 10_000_000 })] })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_QUANTITY' }));
    expect(() => InvoiceMathEngine.calculate({ items: [line({ unitPrice: 100_000_000 })] })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PRICE' }));
    expect(() => InvoiceMathEngine.calculate({ items: [line({ productId: 'a', quantity: 999_999, unitPrice: 99 }), line({ productId: 'b', quantity: 999_999, unitPrice: 99 })] })).toThrow(
      expect.objectContaining({ code: 'ERR_AMOUNT_TOO_LARGE' }),
    );
    // The largest representable line still calculates.
    const max = InvoiceMathEngine.calculate({ items: [line({ quantity: 999_999, unitPrice: 84.74, gstRateStr: 'EIGHTEEN' })] });
    expect(max.finalTotal.lessThanOrEqualTo('99999999.99')).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const input = { items: [line(), line({ productId: '2', unitPrice: 33.33, gstRateStr: 'FIVE' })], discountAmount: 5, discountReason: 'r' };
    const a = InvoiceMathEngine.calculate(input);
    const b = InvoiceMathEngine.calculate(input);
    expect(a.calculationHash).toBe(b.calculationHash);
    expect(a.finalTotal.toString()).toBe(b.finalTotal.toString());
  });

  it('handles a 1000-line invoice with an exact invariant', () => {
    const items = Array.from({ length: 1000 }, (_, i) => line({ productId: `p${i}`, unitPrice: 9.99, quantity: 3, gstRateStr: i % 2 ? 'FIVE' : 'EIGHTEEN' }));
    const result = InvoiceMathEngine.calculate({ items, discountAmount: 123.45, discountReason: 'bulk' });
    const recomputed = result.lines.reduce((acc, l) => acc.plus(l.lineTotal), result.roundOff);
    expect(recomputed.toString()).toBe(result.finalTotal.toString());
    expect(result.totalDiscount.toNumber()).toBe(123.45);
  });
});

describe('InvoiceMathEngine.calculateReturn', () => {
  const original = {
    lineRef: 'item-1',
    originalQuantity: 3,
    unitPrice: 100,
    discountAmount: 30,
    taxableAmount: 270,
    cgstAmount: 24.3,
    sgstAmount: 24.3,
    igstAmount: 0,
    totalAmount: 318.6,
  };

  it('full return reproduces the original amounts', () => {
    const result = InvoiceMathEngine.calculateReturn({ lines: [{ ...original, quantity: 3 }] });
    expect(result.taxableTotal.toNumber()).toBe(270);
    expect(result.totalTax.toNumber()).toBe(48.6);
    expect(result.grandTotal.toNumber()).toBe(318.6);
    expect(result.finalTotal.toNumber()).toBe(319);
  });

  it('partial return scales proportionally', () => {
    const result = InvoiceMathEngine.calculateReturn({ lines: [{ ...original, quantity: 1 }] });
    expect(result.lines[0].discountAmount.toNumber()).toBe(10);
    expect(result.taxableTotal.toNumber()).toBe(90);
    expect(result.totalCgst.toNumber()).toBe(8.1);
    expect(result.grandTotal.toNumber()).toBe(106.2);
    expect(result.finalTotal.toNumber()).toBe(106);
  });

  it('rejects quantity above the original', () => {
    expect(() => InvoiceMathEngine.calculateReturn({ lines: [{ ...original, quantity: 4 }] })).toThrow(InvoiceMathError);
  });
});

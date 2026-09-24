import { InvoiceMathEngine } from '../src/invoice-math.engine';
import { InvoiceMathInput } from '../src/invoice.types';

const goldenInput: InvoiceMathInput = {
  items: [
    { productId: 'P1', quantity: 2, unitPrice: 100, gstRateStr: 'EIGHTEEN', isInterState: false },
    { productId: 'P2', quantity: 1, unitPrice: 250, discountPercent: 10, gstRateStr: 'FIVE', isInterState: false },
    { productId: 'P3', quantity: 3, unitPrice: 50, gstRateStr: 'TWELVE', isInterState: true },
  ],
  discountAmount: 20,
  discountType: 'FIXED_AMOUNT',
  discountReason: 'Loyalty',
};

describe('Golden Master', () => {
  it('produces the exact same output for the frozen input (preview mode)', () => {
    const result = InvoiceMathEngine.calculate(goldenInput);
    expect(result).toMatchSnapshot();
    expect(result.subtotal.toNumber()).toBe(600);
    expect(result.totalItemDiscount.toNumber()).toBe(25);
    expect(result.invoiceDiscount.toNumber()).toBe(20);
    expect(result.taxableTotal.toNumber()).toBe(555);
    expect(result.payment).toBeNull();
    expect(result.finalTotal.toNumber()).toBe(618);
  });

  it('settles the same invoice with a split payment', () => {
    const result = InvoiceMathEngine.calculate({
      ...goldenInput,
      payment: { tenders: [{ type: 'CASH', amount: 400, tenderedAmount: 500 }, { type: 'UPI', amount: 118 }], udharAmount: 100 },
    });
    expect(result.finalTotal.toNumber()).toBe(618);
    expect(result.payment?.changeAmount.toNumber()).toBe(100);
    expect(result.payment?.paymentMode).toBe('SPLIT');
  });
});

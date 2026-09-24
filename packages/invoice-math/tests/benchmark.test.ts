import { InvoiceMathEngine } from '../src/invoice-math.engine';
import { InvoiceMathInput } from '../src/invoice.types';

describe('Benchmark Verification', () => {
  it('calculates 1000 lines in under 100ms', () => {
    const items = Array.from({ length: 1000 }).map((_, i) => ({
      productId: `P${i}`,
      quantity: 2,
      unitPrice: 15.5,
      gstRateStr: i % 2 === 0 ? 'EIGHTEEN' : 'FIVE',
      isInterState: i % 3 === 0,
    }));

    const mathInput: InvoiceMathInput = {
      items,
      discountAmount: 100,
      discountType: 'FIXED_AMOUNT',
      discountReason: 'Bulk',
    };

    InvoiceMathEngine.calculate(mathInput); // warm-up

    const start = performance.now();
    InvoiceMathEngine.calculate(mathInput);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
  });
});

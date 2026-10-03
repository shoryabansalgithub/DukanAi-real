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

    // Best of several runs: a shared CI runner can stall any single run for
    // tens of milliseconds, while a real regression slows every run.
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      InvoiceMathEngine.calculate(mathInput);
      best = Math.min(best, performance.now() - start);
    }

    expect(best).toBeLessThan(100);
  });
});

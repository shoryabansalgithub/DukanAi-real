import { Role } from '@prisma/client';
import { BillingService, NormalisedLine } from './billing.service';
import { BillingFeatureConfig } from '../config/domains/features/billing-feature.config';
import { InvoiceMathEngine } from './utils/invoice-math.engine';

/**
 * Audit B4: the cashier discount authority compares what the cashier typed
 * (percentages) as typed and amounts against what the limit itself yields
 * under the engine's rounding. Comparing re-derived percentages refused the
 * cashier's own 10% on about half of all prices (10% of ₹10.05 is ₹1.01,
 * i.e. 10.05%).
 */
describe('BillingService.enforceDiscountAuthority (audit B4, B5)', () => {
  const config = Object.assign(new BillingFeatureConfig(), { cashierMaxDiscountPercent: 10 });
  const service = Object.create(BillingService.prototype) as BillingService;
  (service as unknown as { billingConfig: BillingFeatureConfig }).billingConfig = config;
  const cashier = { shopId: 's', userId: 'u', role: Role.CASHIER };
  const manager = { ...cashier, role: Role.MANAGER };

  const line = (discountPercent = 0): NormalisedLine => ({ key: 'p', productId: 'p', custom: null, quantity: 1, discountPercent });
  const calc = (price: string, discountPercent = 0, invoice: { type?: string; percentage?: number; amount?: number } = {}) =>
    InvoiceMathEngine.calculate({
      items: [{ productId: 'p', quantity: 1, unitPrice: price, discountPercent, gstRateStr: 'ZERO', isInterState: false }],
      discountType: invoice.type,
      discountPercentage: invoice.percentage,
      discountAmount: invoice.amount,
      discountReason: invoice.type ? 'test' : undefined,
    });
  const allowed = (fn: () => void) => {
    try {
      fn();
      return true;
    } catch (e) {
      if ((e as { response?: { code?: string } }).response?.code === 'DISCOUNT_REQUIRES_APPROVAL') return false;
      throw e;
    }
  };

  it('accepts exactly the limit on every single-line price from 1.00 to 500.00, and refuses the limit + 0.01%', () => {
    const refusedAtLimit: string[] = [];
    const acceptedAbove: string[] = [];
    for (let paise = 100; paise <= 50_000; paise++) {
      const price = (paise / 100).toFixed(2);
      const byLine = calc(price, 10);
      const byInvoice = calc(price, 0, { type: 'PERCENTAGE', percentage: 10 });
      if (!allowed(() => service.enforceDiscountAuthority(cashier, [line(10)], byLine))) refusedAtLimit.push(`${price} line`);
      if (!allowed(() => service.enforceDiscountAuthority(cashier, [line()], byInvoice, 10))) refusedAtLimit.push(`${price} invoice %`);

      if (allowed(() => service.enforceDiscountAuthority(cashier, [line(10.01)], calc(price, 10.01)))) acceptedAbove.push(`${price} line`);
      if (allowed(() => service.enforceDiscountAuthority(cashier, [line()], calc(price, 0, { type: 'PERCENTAGE', percentage: 10.01 }), 10.01))) acceptedAbove.push(`${price} invoice %`);
    }
    expect(refusedAtLimit).toEqual([]);
    expect(acceptedAbove).toEqual([]);
  });

  it('refuses a fixed amount one paisa above what the limit yields, and a line plus an invoice discount that compound', () => {
    expect(allowed(() => service.enforceDiscountAuthority(cashier, [line()], calc('10.05', 0, { type: 'FIXED_AMOUNT', amount: 1.01 })))).toBe(true);
    expect(allowed(() => service.enforceDiscountAuthority(cashier, [line()], calc('10.05', 0, { type: 'FIXED_AMOUNT', amount: 1.02 })))).toBe(false);
    expect(allowed(() => service.enforceDiscountAuthority(cashier, [line(10)], calc('100', 10, { type: 'PERCENTAGE', percentage: 10 }), 10))).toBe(false);
    expect(allowed(() => service.enforceDiscountAuthority(manager, [line(50)], calc('100', 50, { type: 'PERCENTAGE', percentage: 50 }), 50))).toBe(true);
  });

  it('B5: caps the sum of a cashier\'s custom lines per invoice', () => {
    const customs: NormalisedLine[] = ['a', 'b', 'c'].map((n, i) => ({ key: `custom:${i}`, productId: null, custom: { name: n, unitPrice: '400.00', gstRate: 'ZERO', unit: 'PCS' }, quantity: 1, discountPercent: 0 }));
    const math = (count: number) =>
      InvoiceMathEngine.calculate({ items: customs.slice(0, count).map((c) => ({ productId: c.key, quantity: 1, unitPrice: '400.00', gstRateStr: 'ZERO', isInterState: false })) });
    const code = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as { response?: { code?: string } }).response?.code;
      }
    };
    expect(code(() => service.enforceDiscountAuthority(cashier, customs.slice(0, 2), math(2)))).toBeNull();
    expect(code(() => service.enforceDiscountAuthority(cashier, customs, math(3)))).toBe('CUSTOM_LINE_REQUIRES_APPROVAL');
    expect(code(() => service.enforceDiscountAuthority(manager, customs, math(3)))).toBeNull();
  });
});

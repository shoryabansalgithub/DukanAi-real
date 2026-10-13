import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { vendorBillPostingPlan } from '../repositories/vendor-bill.repository';
import { VendorBillTaxService } from './vendor-bill-tax.service';
import { VendorBillOutstandingService } from './vendor-bill-outstanding.service';

const D = (v: string | number) => new Prisma.Decimal(v);
const entries = (plan: ReturnType<typeof vendorBillPostingPlan>) => plan.entries.map((e) => `${e.type} ${e.account} ${new Prisma.Decimal(e.amount.toString()).toFixed(2)}`);

describe('vendor bill money (release audit S3 / L1)', () => {
  it('a bill of 10 × 100 at 18 % on a receipt valued 1000 posts DR INPUT_GST 180 / CR ACCOUNTS_PAYABLE 180', () => {
    const plan = vendorBillPostingPlan([{ base: D(1000), tax: D(180), receiptValue: D(1000), stocked: true }]);
    expect(entries(plan)).toEqual([`DEBIT ${LedgerAccount.INPUT_GST} 180.00`, `CREDIT ${LedgerAccount.ACCOUNTS_PAYABLE} 180.00`]);
    expect(plan.payableDelta.toFixed(2)).toBe('180.00');
  });

  it('a price above the receipt debits INVENTORY with the difference; below it credits INVENTORY', () => {
    expect(entries(vendorBillPostingPlan([{ base: D(1010), tax: D(0), receiptValue: D(1000), stocked: true }]))).toEqual([
      `DEBIT ${LedgerAccount.INVENTORY} 10.00`,
      `CREDIT ${LedgerAccount.ACCOUNTS_PAYABLE} 10.00`,
    ]);
    const lower = vendorBillPostingPlan([{ base: D(990), tax: D(5), receiptValue: D(1000), stocked: true }]);
    expect(entries(lower)).toEqual([`DEBIT ${LedgerAccount.INPUT_GST} 5.00`, `CREDIT ${LedgerAccount.INVENTORY} 10.00`, `DEBIT ${LedgerAccount.ACCOUNTS_PAYABLE} 5.00`]);
    expect(lower.payableDelta.toFixed(2)).toBe('-5.00');
  });

  it('service lines carry no stock: their base is an expense, and every plan balances', () => {
    const plan = vendorBillPostingPlan([
      { base: D(300), tax: D(54), receiptValue: D(0), stocked: false },
      { base: D(1000), tax: D(180), receiptValue: D(1000), stocked: true },
    ]);
    const sum = (type: LedgerEntryType) => plan.entries.filter((e) => e.type === type).reduce((s, e) => s.plus(e.amount.toString()), D(0));
    expect(sum(LedgerEntryType.DEBIT).equals(sum(LedgerEntryType.CREDIT))).toBe(true);
    expect(plan.payableDelta.toFixed(2)).toBe('534.00');
    expect(entries(plan)).toContain(`DEBIT ${LedgerAccount.EXPENSES} 300.00`);
  });

  it('bill totals are Decimal sums of the paisa-rounded lines (no float drift)', () => {
    const taxed = new VendorBillTaxService().prepareTaxLiability(
      [
        { billedQuantity: 3, unitPrice: 0.1, taxPercentage: 18 },
        { billedQuantity: 1.5, unitPrice: 7.33, taxPercentage: 5 },
      ],
      'EXCLUSIVE',
    );
    expect(taxed.lines.map((l) => [l.baseAmount.toFixed(2), l.taxAmount.toFixed(2), l.totalAmount.toFixed(2)])).toEqual([
      ['0.30', '0.06', '0.36'],
      // CGST and SGST are each rounded by the shared engine: 2 × 0.27.
      ['11.00', '0.54', '11.54'],
    ]);
    expect([taxed.totalBase.toFixed(2), taxed.totalTax.toFixed(2), taxed.totalAmount.toFixed(2)]).toEqual(['11.30', '0.60', '11.90']);
    expect(taxed.totalAmount).toBeInstanceOf(Prisma.Decimal);
  });

  it('an instalment never pays more than is outstanding', () => {
    const outstanding = new VendorBillOutstandingService();
    expect(outstanding.processPayment('1180.00', '0', '1180.00')).toMatchObject({ isFullyPaid: true });
    expect(() => outstanding.processPayment('100.00', '0', '100.01')).toThrow();
  });
});

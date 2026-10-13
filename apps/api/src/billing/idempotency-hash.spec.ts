import * as crypto from 'crypto';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceWithRelations } from './billing.types';

/**
 * Audit P1-4: the cash handed over is not part of what makes two checkout
 * requests the same bill, and a key stored by the earlier formula (with the
 * cash tendered) still replays across the upgrade.
 */
describe('BillingService checkout request identity (audit P1-4)', () => {
  const service = Object.create(BillingService.prototype) as BillingService;
  const internals = service as unknown as {
    normaliseLines: BillingService['normaliseLines'];
    toPaymentInput: BillingService['toPaymentInput'];
    hashRequest: (payload: unknown, legacy?: boolean) => string;
    replayOrReject: (existing: InvoiceWithRelations, requestHash: string, payload: unknown) => { replayed: boolean };
  };
  const payloadOf = (dto: Partial<CreateInvoiceDto>) => {
    const full = { idempotencyKey: 'k', items: [{ productId: 'p', quantity: 2 }], ...dto } as CreateInvoiceDto;
    return { lines: internals.normaliseLines(full.items), dto: full, paymentInput: internals.toPaymentInput(full.payments ?? [], full.udharAmount) };
  };
  const cash = (tenderedAmount?: number) => payloadOf({ payments: [{ tender: 'CASH', amount: 236, tenderedAmount }] });
  const existing = (requestHash: string) => ({ id: 'inv-1', invoiceNumber: 'INV-2627-000001', requestHash, shiftId: null }) as unknown as InvoiceWithRelations;

  it('hashes the same bill the same whatever cash was tendered', () => {
    const hashes = [cash(), cash(500), cash(2000)].map((p) => internals.hashRequest(p));
    expect(new Set(hashes).size).toBe(1);
    expect(internals.hashRequest(payloadOf({ payments: [{ tender: 'UPI', amount: 236 }] }))).not.toBe(hashes[0]);
    expect(internals.hashRequest(payloadOf({ payments: [{ tender: 'CASH', amount: 236 }], placeOfSupply: 'Kerala' }))).not.toBe(hashes[0]);
  });

  it('replays a key stored before the upgrade (cash tendered in its hash) for the same request', () => {
    const legacyStored = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          lines: [{ key: 'p', productId: 'p', custom: null, quantity: 2, discountPercent: 0 }],
          customerId: null,
          discountAmount: null,
          discountPercentage: null,
          discountType: null,
          tenders: [{ type: 'CASH', amount: 236, tendered: 500 }],
          udhar: '0.00',
        }),
      )
      .digest('hex');
    expect(internals.hashRequest(cash(500), true)).toBe(legacyStored);
    expect(internals.replayOrReject(existing(legacyStored), internals.hashRequest(cash(500)), cash(500)).replayed).toBe(true);
    // A different bill under the stored key is a reuse, named.
    const other = payloadOf({ items: [{ productId: 'p', quantity: 3 }], payments: [{ tender: 'CASH', amount: 354 }] });
    expect(() => internals.replayOrReject(existing(legacyStored), internals.hashRequest(other), other)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', details: { invoiceId: 'inv-1', invoiceNumber: 'INV-2627-000001' } }) }),
    );
  });
});

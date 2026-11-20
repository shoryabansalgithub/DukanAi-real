/**
 * The POS / billing findings of the release-readiness audit of 2026-10-11,
 * each against the real stack (HTTP, MySQL, Redis) with a settable
 * application clock: MRP is tax-inclusive (P1-2), a counter sale is
 * intra-state (P1-3), a retried bill is the same bill whatever cash was
 * handed over (P1-4), the cashier's discount, custom-line and return
 * authority (B4, B5, B6), damaged returns (B7), the credit-note deadline
 * (B8), cashier-created customers (B9), zero-value lines (B11), the
 * idempotency races (B12), money bounds (B14), discount metadata (B15),
 * cost of goods on piecewise returns (B16) and udhar rows on the clock. The
 * main shop reconciles CLEAN at the end.
 */
import { INestApplication } from '@nestjs/common';
import { ReconciliationTrigger, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Clock } from '../../src/common/time/clock';
import { businessDateString } from '../../src/common/time/business-day';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { cashierOf, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);
const TZ = 'Asia/Kolkata';

/** The system clock until a test fixes it; `release()` goes back to it. */
class TestClock extends Clock {
  private fixed: Date | null = null;
  override now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }
  set(iso: string | Date): Date {
    this.fixed = new Date(iso);
    return this.now();
  }
  release(): void {
    this.fixed = null;
  }
}

type Http = Awaited<ReturnType<typeof httpAs>>;
type Line = { productId?: string; quantity: number; discountPercent?: number; custom?: Record<string, unknown> };
type Tender = { tender: string; amount: number; tenderedAmount?: number };

describe('POS audit fixes (2026-10-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let recon: ReconciliationService;
  const clock = new TestClock();
  let shop: TestShop;
  let owner: Http;
  let cashier: Http;
  const p: Record<string, string> = {};

  const sell = (who: Http, items: Line[], payments: Tender[], extra: Record<string, unknown> = {}) =>
    who.post('/api/billing/invoice').send({ idempotencyKey: randomUUID(), items, payments, ...extra });
  const giveBack = (who: Http, invoiceId: string, extra: Record<string, unknown> = {}) =>
    who.post('/api/billing/returns').send({ idempotencyKey: randomUUID(), invoiceId, ...extra });
  const lineOf = (sale: { body: { invoice: { items: Array<{ id: string; productId: string | null }> } } }, productId: string) =>
    sale.body.invoice.items.find((i) => i.productId === productId)!.id;

  beforeAll(async () => {
    app = await bootApp((builder) => builder.overrideProvider(Clock).useValue(clock));
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    recon = app.get(ReconciliationService);
    shop = await createShop(app, 'audfix', { creditLimit: 100_000 });
    owner = await httpAs(app, shop, ownerOf(shop));
    cashier = await httpAs(app, shop, cashierOf(shop));

    p.tea = await createProduct(app, shop, { key: 'TEA', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
    p.big = await createProduct(app, shop, { key: 'BIG', sellingPrice: 3000, costPrice: 1000, gstRate: 'ZERO' });
    p.cheap = await createProduct(app, shop, { key: 'CHEAP', sellingPrice: 10.05, costPrice: 5, gstRate: 'ZERO' });
    p.half = await createProduct(app, shop, { key: 'HALF', sellingPrice: 0.5, costPrice: 0.2, gstRate: 'ZERO' });
    p.free = await createProduct(app, shop, { key: 'FREE', sellingPrice: 0, costPrice: 0, gstRate: 'ZERO' });
    p.kg = await createProduct(app, shop, { key: 'DAL', unit: 'KG', sellingPrice: 50, costPrice: 33.33, gstRate: 'ZERO' });
    // Older rows the products API no longer accepts: an MRP below the price with GST, and none at all.
    p.belowMrp = await createProduct(app, shop, { key: 'BELOW', sellingPrice: 100, gstRate: 'EIGHTEEN', mrp: 100 });
    p.noMrp = await createProduct(app, shop, { key: 'NOMRP', sellingPrice: 100, gstRate: 'EIGHTEEN', mrp: 0 });
    for (const key of ['tea', 'big', 'cheap', 'half', 'free', 'kg', 'belowMrp', 'noMrp']) await receiveStock(app, shop, p[key], 100);

    expect((await owner.post('/api/shifts/open').send({ openingCash: 1000 })).status).toBe(201);
    expect((await cashier.post('/api/shifts/open').send({ openingCash: 1000 })).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => clock.release());

  it('P1-2: a product that would sell above its MRP with GST is refused at preview and checkout; an MRP of 0 is none', async () => {
    const preview = await cashier.post('/api/billing/calculate').send({ items: [{ productId: p.belowMrp, quantity: 1 }] });
    expect([preview.status, preview.body.code, preview.body.details]).toEqual([
      409,
      'PRICE_ABOVE_MRP',
      expect.objectContaining({ productId: p.belowMrp, mrp: 100, inclusivePrice: 118 }),
    ]);
    expect(preview.body.message).toMatch(/BELOW .*118\.00.*MRP of 100\.00.*manager/);
    const sale = await sell(cashier, [{ productId: p.belowMrp, quantity: 1 }], [{ tender: 'CASH', amount: 118 }]);
    expect([sale.status, sale.body.code]).toEqual([409, 'PRICE_ABOVE_MRP']);
    expect(await run.system(() => prisma.invoiceItem.count({ where: { productId: p.belowMrp } }))).toBe(0);

    const unprinted = await sell(cashier, [{ productId: p.noMrp, quantity: 1 }], [{ tender: 'CASH', amount: 118 }]);
    expect(unprinted.status).toBe(201);
  });

  it('P1-3: a counter sale is intra-state whatever state the customer lives in; an explicit place of supply decides IGST, and its return keeps it', async () => {
    const delhi = await owner.post('/api/customers').send({ name: 'Delhi buyer', phone: `8${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '5')}`, state: 'Delhi' });
    expect(delhi.status).toBe(201);

    const counter = await sell(cashier, [{ productId: p.tea, quantity: 1 }], [{ tender: 'CASH', amount: 118 }], { customerId: delhi.body.id });
    expect(counter.status).toBe(201);
    expect([counter.body.invoice.isInterState, num(counter.body.invoice.cgstAmount), num(counter.body.invoice.igstAmount)]).toEqual([false, 9, 0]);

    const delivery = await sell(owner, [{ productId: p.tea, quantity: 1 }], [{ tender: 'UPI', amount: 118 }], { customerId: delhi.body.id, placeOfSupply: 'NCT of Delhi' });
    expect(delivery.status).toBe(201);
    expect([delivery.body.invoice.isInterState, num(delivery.body.invoice.cgstAmount), num(delivery.body.invoice.igstAmount)]).toEqual([true, 0, 18]);
    expect((await sell(owner, [{ productId: p.tea, quantity: 1 }], [{ tender: 'UPI', amount: 118 }], { placeOfSupply: 'Atlantis' })).status).toBe(400);

    // The return reverses IGST as charged, and (no tender named) refunds by the sale's own tender (B6).
    const ret = await giveBack(owner, delivery.body.invoice.id);
    expect(ret.status).toBe(201);
    expect([ret.body.invoice.isInterState, num(ret.body.invoice.igstAmount), ret.body.invoice.payments.map((t: { tender: string }) => t.tender)]).toEqual([true, 18, ['UPI']]);
  });

  it('B6: an unnamed refund tender is the sale tender for a single-tender sale, cash for a split one', async () => {
    const split = await sell(owner, [{ productId: p.tea, quantity: 1 }], [{ tender: 'CASH', amount: 50 }, { tender: 'UPI', amount: 68 }]);
    expect(split.status).toBe(201);
    const ret = await giveBack(owner, split.body.invoice.id);
    expect(ret.body.invoice.payments.map((t: { tender: string }) => t.tender)).toEqual(['CASH']);
  });

  it('P1-4: the same bill retried with a different cash tendered replays; another bill under the key is 422 naming the saved invoice', async () => {
    const key = randomUUID();
    const bill = (quantity: number, tenderedAmount?: number) => ({ idempotencyKey: key, items: [{ productId: p.tea, quantity }], payments: [{ tender: 'CASH', amount: 118 * quantity, tenderedAmount }] });
    const first = await cashier.post('/api/billing/invoice').send(bill(1, 200));
    expect(first.status).toBe(201);
    const retried = await cashier.post('/api/billing/invoice').send(bill(1, 500));
    expect([retried.status, retried.body.invoice.id, num(retried.body.invoice.changeAmount)]).toEqual([200, first.body.invoice.id, 82]);
    const exact = await cashier.post('/api/billing/invoice').send(bill(1));
    expect([exact.status, exact.body.invoice.id]).toEqual([200, first.body.invoice.id]);

    const other = await cashier.post('/api/billing/invoice').send(bill(2));
    expect([other.status, other.body.code, other.body.details]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED', { invoiceId: first.body.invoice.id, invoiceNumber: first.body.invoice.invoiceNumber }]);
    expect(await run.system(() => prisma.invoice.count({ where: { shopId: shop.shopId, idempotencyKey: key } }))).toBe(1);
  });

  it('B4: a cashier discount of exactly the limit passes whatever the rounding; above it is refused', async () => {
    const calc = (extra: Record<string, unknown>, items: Line[] = [{ productId: p.cheap, quantity: 1 }]) => cashier.post('/api/billing/calculate').send({ items, ...extra });
    // 10% of 10.05 rounds to 1.01, which is 10.05% of the line.
    const pct = await calc({ discountType: 'PERCENTAGE', discountPercentage: 10, discountReason: 'regular' });
    expect([pct.status, num(pct.body.invoiceDiscount)]).toEqual([200, 1.01]);
    expect((await calc({ discountType: 'FIXED_AMOUNT', discountAmount: 1.01, discountReason: 'regular' })).status).toBe(200);
    expect((await calc({}, [{ productId: p.cheap, quantity: 1, discountPercent: 10 }])).status).toBe(200);
    for (const extra of [
      { discountType: 'PERCENTAGE', discountPercentage: 10.01, discountReason: 'too much' },
      { discountType: 'FIXED_AMOUNT', discountAmount: 1.02, discountReason: 'too much' },
    ]) {
      const refused = await calc(extra);
      expect([refused.status, refused.body.code]).toEqual([403, 'DISCOUNT_REQUIRES_APPROVAL']);
    }
    const compounding = await calc({ discountType: 'PERCENTAGE', discountPercentage: 10, discountReason: 'both' }, [{ productId: p.cheap, quantity: 1, discountPercent: 10 }]);
    expect([compounding.status, compounding.body.code]).toEqual([403, 'DISCOUNT_REQUIRES_APPROVAL']);
  });

  it('B15: the invoice stores the discount the engine applied, type and percent included', async () => {
    const stored = async (res: { status: number; body: { invoice: { id: string } } }) => {
      expect(res.status).toBe(201);
      const row = await run.system(() => prisma.invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } }));
      return [row.discountType, row.discountPercentage === null ? null : num(row.discountPercentage), num(row.discountAmount)];
    };
    const items = [{ productId: p.cheap, quantity: 10 }]; // 100.50
    expect(await stored(await sell(owner, items, [{ tender: 'UPI', amount: 95 }], { discountType: 'PERCENTAGE', discountPercentage: 5, discountReason: 'loyal' }))).toEqual(['PERCENTAGE', 5, 5.03]);
    expect(await stored(await sell(owner, items, [{ tender: 'UPI', amount: 90 }], { discountType: 'FIXED_AMOUNT', discountAmount: 10.5, discountPercentage: 7, discountReason: 'round' }))).toEqual(['FIXED_AMOUNT', null, 10.5]);
    expect(await stored(await sell(owner, [{ productId: p.cheap, quantity: 10, discountPercent: 10 }], [{ tender: 'UPI', amount: 90 }]))).toEqual([null, null, 10.05]);
  });

  it("B5: a cashier's custom lines are capped per invoice as well as per line", async () => {
    const custom = (name: string) => ({ custom: { name, unitPrice: 400, gstRate: 'ZERO' }, quantity: 1 });
    const three = [custom('one'), custom('two'), custom('three')];
    const refused = await cashier.post('/api/billing/calculate').send({ items: three });
    expect([refused.status, refused.body.code, refused.body.details]).toEqual([403, 'CUSTOM_LINE_REQUIRES_APPROVAL', { maxTotal: 1000, customTotal: 1200 }]);
    expect((await cashier.post('/api/billing/calculate').send({ items: three.slice(0, 2) })).status).toBe(200);
    expect((await owner.post('/api/billing/calculate').send({ items: three })).status).toBe(200);
  });

  it('B9: a customer a cashier adds starts with no credit; a manager gets the shop default', async () => {
    const phone = (d: string) => `7${shop.suffix.replace(/\D/g, '').slice(-8)}${d}`;
    const byCashier = await cashier.post('/api/customers').send({ name: 'Walk-in regular', phone: phone('6') });
    expect([byCashier.status, num(byCashier.body.creditLimit)]).toEqual([201, 0]);
    const byOwner = await owner.post('/api/customers').send({ name: 'Trusted regular', phone: phone('7') });
    expect([byOwner.status, num(byOwner.body.creditLimit)]).toEqual([201, 5000]);
  });

  it('B6: a cashier refund above BILLING_CASHIER_MAX_REFUND_AMOUNT needs a manager', async () => {
    const sale = await sell(owner, [{ productId: p.big, quantity: 1 }], [{ tender: 'CASH', amount: 3000 }]);
    expect(sale.status).toBe(201);
    const refused = await giveBack(cashier, sale.body.invoice.id, { refund: { tender: 'CASH' } });
    expect([refused.status, refused.body.code, refused.body.details]).toEqual([403, 'RETURN_REQUIRES_APPROVAL', expect.objectContaining({ maxRefund: 2000, refund: 3000 })]);
    expect(await run.system(() => prisma.invoice.count({ where: { originalId: sale.body.invoice.id } }))).toBe(0);
    expect((await giveBack(owner, sale.body.invoice.id, { refund: { tender: 'CASH' } })).status).toBe(201);
  });

  it('B7: damaged and expired returns are refunded but not restocked, and their cost stays in cost of goods', async () => {
    const readers = makeReaders(app, shop);
    const sale = await sell(cashier, [{ productId: p.tea, quantity: 3 }], [{ tender: 'CASH', amount: 354 }]);
    expect(sale.status).toBe(201);
    const line = lineOf(sale, p.tea);
    const stock = await readers.onHand(p.tea);
    const cogs = await readers.ledgerBalance('COST_OF_GOODS');
    const inventory = await readers.ledgerBalance('INVENTORY');

    for (const reason of ['DAMAGED', 'EXPIRED']) {
      const res = await giveBack(cashier, sale.body.invoice.id, { items: [{ invoiceItemId: line, quantity: 1 }], reason, refund: { tender: 'CASH' } });
      expect([reason, res.status, num(res.body.invoice.totalAmount)]).toEqual([reason, 201, 118]);
    }
    expect(await readers.onHand(p.tea)).toBe(stock);
    expect(await readers.ledgerBalance('COST_OF_GOODS')).toBe(cogs);
    expect(await readers.ledgerBalance('INVENTORY')).toBe(inventory);

    const resaleable = await giveBack(cashier, sale.body.invoice.id, { items: [{ invoiceItemId: line, quantity: 1 }], reason: 'CUSTOMER_CHANGED_MIND', refund: { tender: 'CASH' } });
    expect(resaleable.status).toBe(201);
    expect(await readers.onHand(p.tea)).toBe(stock! + 1);
    expect(await readers.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(cogs - 60, 2);
  });

  it('B11: a zero-value line never keeps a sale from completing; the last return refunds the round-off', async () => {
    // 3 x 0.50 + a free item: 1.50 rounds to 2.00.
    const sale = await sell(owner, [{ productId: p.half, quantity: 3 }, { productId: p.free, quantity: 1 }], [{ tender: 'UPI', amount: 2 }]);
    expect([sale.status, num(sale.body.invoice.totalAmount)]).toEqual([201, 2]);
    const ret = await giveBack(owner, sale.body.invoice.id, { items: [{ invoiceItemId: lineOf(sale, p.half), quantity: 3 }], refund: { tender: 'UPI' } });
    expect([ret.status, num(ret.body.invoice.totalAmount)]).toEqual([201, 2]);
  });

  it('B12: concurrent requests with one key are one document: the same return replays, a different bill or return is 422, never a duplicate or a 409', async () => {
    const key = randomUUID();
    const bills = await Promise.all([1, 2, 3, 4].map((quantity) => owner.post('/api/billing/invoice').send({ idempotencyKey: key, items: [{ productId: p.tea, quantity }], payments: [{ tender: 'UPI', amount: 118 * quantity }] })));
    const statuses = bills.map((b) => b.status).sort();
    expect(statuses).toEqual([201, 422, 422, 422]);
    for (const b of bills.filter((x) => x.status === 422)) expect(b.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const sale = await sell(owner, [{ productId: p.tea, quantity: 4 }], [{ tender: 'UPI', amount: 472 }]);
    const line = lineOf(sale, p.tea);
    const returnKey = randomUUID();
    const same = await Promise.all([0, 1, 2].map(() => owner.post('/api/billing/returns').send({ idempotencyKey: returnKey, invoiceId: sale.body.invoice.id, items: [{ invoiceItemId: line, quantity: 1 }], refund: { tender: 'UPI' } })));
    expect(same.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(same.map((r) => r.body.invoice.id)).size).toBe(1);

    const otherKey = randomUUID();
    const differing = await Promise.all([1, 2].map((quantity) => owner.post('/api/billing/returns').send({ idempotencyKey: otherKey, invoiceId: sale.body.invoice.id, items: [{ invoiceItemId: line, quantity }], refund: { tender: 'UPI' } })));
    expect(differing.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(differing.find((r) => r.status === 422)!.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await run.system(() => prisma.invoice.count({ where: { shopId: shop.shopId, idempotencyKey: { in: [returnKey, otherKey] } } }))).toBe(2);
  });

  it('B16: the returns of a weighed line give back exactly the cost of goods its sale booked', async () => {
    const readers = makeReaders(app, shop);
    const cogsBefore = await readers.ledgerBalance('COST_OF_GOODS');
    // 2.345 kg at 50.00 = 117.25, rounds to 117; cost 33.33/kg = 78.16 (78.15885).
    const sale = await sell(owner, [{ productId: p.kg, quantity: 2.345 }], [{ tender: 'UPI', amount: 117 }]);
    expect(sale.status).toBe(201);
    expect(await readers.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(cogsBefore + 78.16, 2);
    const line = lineOf(sale, p.kg);
    for (const quantity of [0.001, 0.001, 2.343]) {
      const res = await giveBack(owner, sale.body.invoice.id, { items: [{ invoiceItemId: line, quantity }], refund: { tender: 'UPI' } });
      expect([quantity, res.status]).toEqual([quantity, 201]);
    }
    // Rounded on its own, each return booked 0.03 + 0.03 + 78.09 = 78.15 and left a paisa behind.
    expect(await readers.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(cogsBefore, 2);
  });

  it('udhar rows carry the clock instant of their document', async () => {
    const at = clock.set(new Date(Date.now() - 60_000));
    const sale = await sell(owner, [{ productId: p.tea, quantity: 1 }], [], { customerId: shop.customerId, udharAmount: 118 });
    expect(sale.status).toBe(201);
    const credit = await run.system(() => prisma.udharTransaction.findFirstOrThrow({ where: { invoiceId: sale.body.invoice.id, type: 'CREDIT' } }));
    expect(credit.createdAt.getTime()).toBe(at.getTime());

    const later = clock.set(new Date(at.getTime() + 30_000));
    const ret = await giveBack(owner, sale.body.invoice.id);
    expect(ret.status).toBe(201);
    const adjustment = await run.system(() => prisma.udharTransaction.findFirstOrThrow({ where: { invoiceId: ret.body.invoice.id, type: 'ADJUSTMENT' } }));
    expect(adjustment.createdAt.getTime()).toBe(later.getTime());
  });

  it("the main shop's day reconciles CLEAN after all of the above", async () => {
    const report = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => recon.runForShop(shop.shopId, { trigger: ReconciliationTrigger.MANUAL, date: businessDateString(new Date(), TZ) }));
    expect(report.checks.flatMap((c) => c.drifts)).toEqual([]);
    expect(report.status).toBe('CLEAN');
  });

  describe('dated rules (a second shop, on the clock)', () => {
    let other: TestShop;
    let otherOwner: Http;
    let otherCashier: Http;
    let tea: string;

    beforeAll(async () => {
      other = await createShop(app, 'audfix2');
      otherOwner = await httpAs(app, other, ownerOf(other));
      otherCashier = await httpAs(app, other, cashierOf(other));
      tea = await createProduct(app, other, { key: 'TEA2', sellingPrice: 100, costPrice: 60, gstRate: 'EIGHTEEN' });
      await receiveStock(app, other, tea, 100);
    });

    it('B8: no return after 30 November following the end of the financial year of the sale (CGST s.34(2))', async () => {
      clock.set('2025-03-31T18:00:00+05:30'); // FY 2024-25
      const march = await sell(otherOwner, [{ productId: tea, quantity: 2 }], [{ tender: 'UPI', amount: 236 }]);
      clock.set('2025-04-01T10:00:00+05:30'); // FY 2025-26
      const april = await sell(otherOwner, [{ productId: tea, quantity: 1 }], [{ tender: 'UPI', amount: 118 }]);
      expect([march.status, april.status]).toEqual([201, 201]);
      const one = (sale: typeof march) => ({ items: [{ invoiceItemId: lineOf(sale, tea), quantity: 1 }], refund: { tender: 'UPI' } });

      clock.set('2025-11-30T23:30:00+05:30');
      expect((await giveBack(otherOwner, march.body.invoice.id, one(march))).status).toBe(201);
      clock.set('2025-12-01T00:30:00+05:30');
      const late = await giveBack(otherOwner, march.body.invoice.id, one(march));
      expect([late.status, late.body.code, late.body.details?.deadline]).toEqual([409, 'RETURN_PAST_GST_DEADLINE', '2025-11-30']);
      expect(late.body.message).toMatch(/outside the app/);
      // The April sale belongs to FY 2025-26: its deadline is 30 November 2026.
      expect((await giveBack(otherOwner, april.body.invoice.id, one(april))).status).toBe(201);
    });

    it('B6: a cashier takes returns against sales up to BILLING_CASHIER_RETURN_WINDOW_DAYS business days old', async () => {
      expect((await otherCashier.post('/api/shifts/open').send({ openingCash: 500 })).status).toBe(201);
      const now = Date.now();
      clock.set(new Date(now - 8 * 86_400_000));
      const old = await sell(otherOwner, [{ productId: tea, quantity: 1 }], [{ tender: 'UPI', amount: 118 }]);
      clock.set(new Date(now - 7 * 86_400_000));
      const recent = await sell(otherOwner, [{ productId: tea, quantity: 1 }], [{ tender: 'UPI', amount: 118 }]);
      clock.release();
      const refused = await giveBack(otherCashier, old.body.invoice.id);
      expect([refused.status, refused.body.code, refused.body.details]).toEqual([403, 'RETURN_REQUIRES_APPROVAL', expect.objectContaining({ windowDays: 7, saleAgeDays: 8 })]);
      expect((await giveBack(otherCashier, recent.body.invoice.id)).status).toBe(201);
      expect((await giveBack(otherOwner, old.body.invoice.id)).status).toBe(201);
    });

    it('B14: a customer balance and every customer amount stay inside Decimal(10,2)', async () => {
      await run.system(() => prisma.customer.update({ where: { id: other.customerId }, data: { outstandingBalance: 99_999_500, creditLimit: 99_999_999.99 } }));
      const overflow = await sell(otherOwner, [{ productId: tea, quantity: 10 }], [], { customerId: other.customerId, udharAmount: 1180 });
      expect([overflow.status, overflow.body.code]).toEqual([409, 'OUTSTANDING_BALANCE_TOO_LARGE']);
      const payment = await otherOwner.post(`/api/customers/${other.customerId}/payments`).send({ idempotencyKey: randomUUID(), amount: 100_000_000, tender: 'CASH' });
      expect(payment.status).toBe(400);
      expect((await otherOwner.patch(`/api/customers/${other.customerId}`).send({ creditLimit: 100_000_000 })).status).toBe(400);
      expect((await otherOwner.patch(`/api/customers/${other.customerId}`).send({ creditLimit: 99_999_999.99 })).status).toBe(200);
    });
  });
});

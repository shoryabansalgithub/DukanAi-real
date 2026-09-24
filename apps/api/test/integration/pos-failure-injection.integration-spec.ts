/**
 * Roadmap Phase 4, target 2 (failure injection) and target 3 (duplicate
 * requests). `BillingCheckpoints` is overridden with an injector that throws
 * at one named point inside the money transactions; after every injected
 * failure the complete persisted state (invoices, lines, tenders, stock,
 * stock ledger, inventory log, double-entry ledger and balances, customer,
 * shift, number sequences, audit, outbox) and the Redis stock keys must be
 * byte-for-byte what they were before the request.
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CustomersService } from '../../src/customers/customers.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { BillingCheckpoints, BillingCheckpoint, BillingFlow, BILLING_CHECKPOINTS } from '../../src/billing/billing-checkpoints';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { actorFor, bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);

class FaultInjector extends BillingCheckpoints {
  failAt: { point: BillingCheckpoint; flow: BillingFlow } | null = null;
  reached: string[] = [];
  async reach(point: BillingCheckpoint, flow: BillingFlow): Promise<void> {
    this.reached.push(`${flow}:${point}`);
    if (this.failAt && this.failAt.point === point && this.failAt.flow === flow) {
      throw new Error(`INJECTED_FAILURE:${flow}:${point}`);
    }
  }
}

const RETURN_POINTS: BillingCheckpoint[] = BILLING_CHECKPOINTS.filter((p) => !['BEFORE_PAYMENT', 'AFTER_PAYMENT'].includes(p));
const REPAYMENT_POINTS: BillingCheckpoint[] = ['BEFORE_PAYMENT', 'BEFORE_CUSTOMER', 'AFTER_CUSTOMER', 'BEFORE_SHIFT', 'BEFORE_LEDGER', 'AFTER_LEDGER', 'BEFORE_AUDIT', 'EVENT_STAGING', 'BEFORE_COMMIT'];

describe('POS failure injection (no partial state survives a failure at any point)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let customers: CustomersService;
  let shifts: ShiftsService;
  let redis: Redis;
  let shop: TestShop;
  let run: ReturnType<typeof tenantRunner>;
  let readers: ReturnType<typeof makeReaders>;
  const injector = new FaultInjector();
  const products: Record<string, string> = {};

  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);

  /** Everything a sale, return, cancel or repayment may touch. */
  const snapshot = async () =>
    run.system(async () => {
      const [invoices, items, payments, inventoryItems, ledgerEntries, logs, ledgerTx, balances, customer, shiftRow, outbox, audits, udhar, sequences, redisKeys] = await Promise.all([
        prisma.invoice.findMany({ where: { shopId: shop.shopId }, select: { id: true, status: true, totalAmount: true, cancelledAt: true }, orderBy: { createdAt: 'asc' } }),
        prisma.invoiceItem.findMany({ where: { invoice: { shopId: shop.shopId } }, select: { id: true, returnedQuantity: true }, orderBy: { id: 'asc' } }),
        prisma.invoicePayment.count({ where: { shopId: shop.shopId } }),
        prisma.inventoryItem.findMany({ where: { shopId: shop.shopId }, select: { id: true, onHand: true, reserved: true, version: true }, orderBy: { id: 'asc' } }),
        prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId } }),
        prisma.inventoryLog.count({ where: { shopId: shop.shopId } }),
        prisma.ledgerTransaction.count({ where: { shopId: shop.shopId } }),
        prisma.ledgerAccountBalance.findMany({ where: { shopId: shop.shopId }, select: { account: true, balance: true }, orderBy: { account: 'asc' } }),
        prisma.customer.findUniqueOrThrow({ where: { id: shop.customerId }, select: { outstandingBalance: true, totalPurchases: true, totalPaid: true } }),
        prisma.shift.findFirst({ where: { shopId: shop.shopId, status: 'OPEN' }, select: { id: true, expectedCash: true, totalSales: true, cashSales: true, udharSales: true, totalReceipts: true } }),
        prisma.outboxEvent.count({ where: { shopId: shop.shopId } }),
        prisma.auditLog.groupBy({ by: ['action'], where: { shopId: shop.shopId }, _count: { _all: true }, orderBy: { action: 'asc' } }),
        prisma.udharTransaction.count({ where: { shopId: shop.shopId } }),
        prisma.numberSequence.findMany({ where: { shopId: shop.shopId }, select: { prefix: true, lastNumber: true }, orderBy: { prefix: 'asc' } }),
        Promise.all(Object.values(products).map((id) => redis.get(`stock:${shop.shopId}:${id}`))),
      ]);
      const products$ = await prisma.product.findMany({ where: { shopId: shop.shopId }, select: { id: true, currentStock: true, stockVersion: true }, orderBy: { id: 'asc' } });
      const [productEvents, customerAudits, adjustments, alerts, notifications, warehouses, locations, ledgerPostings] = await Promise.all([
        prisma.productEventLog.count({ where: { shopId: shop.shopId } }),
        prisma.customerAudit.count({ where: { customerId: shop.customerId } }),
        prisma.inventoryAdjustment.count({ where: { shopId: shop.shopId } }),
        prisma.inventoryAlert.count({ where: { shopId: shop.shopId } }),
        prisma.notification.count({ where: { shopId: shop.shopId } }),
        prisma.warehouse.count({ where: { shopId: shop.shopId } }),
        prisma.location.count({ where: { shopId: shop.shopId } }),
        prisma.ledgerPosting.count({ where: { shopId: shop.shopId } }),
      ]);
      return JSON.stringify({ invoices, items, payments, inventoryItems, ledgerEntries, logs, ledgerTx, balances, customer, shiftRow, outbox, audits, udhar, sequences, redisKeys, products: products$, productEvents, customerAudits, adjustments, alerts, notifications, warehouses, locations, ledgerPostings });
    });

  const saleDto = () => ({
    idempotencyKey: randomUUID(),
    customerId: shop.customerId,
    items: [
      { productId: products.tea, quantity: 2 },
      { productId: products.service, quantity: 1 },
      { custom: { name: 'Gift wrap', unitPrice: 50, gstRate: 'EIGHTEEN' as const }, quantity: 1 },
    ],
    // 2×100 + 200 + 50 = 450 taxable, 18% = 81 → 531; 400 cash, 131 credit
    payments: [{ tender: TenderType.CASH, amount: 400, tenderedAmount: 500 }],
    udharAmount: 131,
  });

  beforeAll(async () => {
    app = await bootApp((b) => b.overrideProvider(BillingCheckpoints).useValue(injector));
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    customers = app.get(CustomersService);
    shifts = app.get(ShiftsService);
    redis = app.get<Redis>(REDIS_CLIENT);
    run = tenantRunner(app);
    shop = await createShop(app, 'fi', { creditLimit: 100000 });
    readers = makeReaders(app, shop);
    products.tea = await createProduct(app, shop, { key: 'TEA' });
    products.service = await createProduct(app, shop, { key: 'SVC', type: 'SERVICE', sellingPrice: 200, costPrice: 0 });
    await receiveStock(app, shop, products.tea, 100);
    await asCashier(() => shifts.open({ openingCash: 1000 }, cashier()));
    // One committed sale so the Redis keys exist and the flows have something to reverse.
    const warm = await asCashier(() => billing.createInvoice(saleDto(), cashier()));
    expect(warm.invoice.status).toBe('COMPLETED');
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    injector.failAt = null;
  });

  describe.each(BILLING_CHECKPOINTS)('sale fails at %s', (point) => {
    it('leaves no partial state and the Redis stock key restored', async () => {
      const before = await snapshot();
      injector.failAt = { point, flow: 'SALE' };
      injector.reached = [];
      const dto = saleDto();
      await expect(asCashier(() => billing.createInvoice(dto, cashier()))).rejects.toThrow(`INJECTED_FAILURE:SALE:${point}`);
      expect(injector.reached).toContain(`SALE:${point}`);
      expect(await snapshot()).toBe(before);

      // Duplicate request after a lost response: the same key now succeeds exactly once.
      injector.failAt = null;
      const retry = await asCashier(() => billing.createInvoice(dto, cashier()));
      expect(retry.replayed).toBe(false);
      const again = await asCashier(() => billing.createInvoice(dto, cashier()));
      expect(again.replayed).toBe(true);
      expect(again.invoice.id).toBe(retry.invoice.id);
      expect(await run.system(() => prisma.invoice.count({ where: { shopId: shop.shopId, idempotencyKey: dto.idempotencyKey } }))).toBe(1);
      expect(await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId, referenceId: retry.invoice.id } }))).toBe(1);
    });
  });

  describe.each(RETURN_POINTS)('return fails at %s', (point) => {
    it('leaves no partial state', async () => {
      const sale = await asCashier(() => billing.createInvoice(saleDto(), cashier()));
      const before = await snapshot();
      injector.failAt = { point, flow: 'RETURN' };
      const dto = { idempotencyKey: randomUUID(), invoiceId: sale.invoice.id, refund: { tender: TenderType.CASH } };
      await expect(asCashier(() => reversal.processReturn(dto, cashier()))).rejects.toThrow(`INJECTED_FAILURE:RETURN:${point}`);
      expect(await snapshot()).toBe(before);
      injector.failAt = null;
      const done = await asCashier(() => reversal.processReturn(dto, cashier()));
      expect(done.invoice.type).toBe('SALES_RETURN');
      expect(num(done.invoice.totalAmount)).toBe(num(sale.invoice.totalAmount));
    });
  });

  describe.each(RETURN_POINTS)('cancellation fails at %s', (point) => {
    it('leaves no partial state', async () => {
      const sale = await asCashier(() => billing.createInvoice(saleDto(), cashier()));
      const before = await snapshot();
      injector.failAt = { point, flow: 'CANCEL' };
      await expect(asCashier(() => reversal.cancelInvoice(sale.invoice.id, { reason: 'test' }, cashier()))).rejects.toThrow(`INJECTED_FAILURE:CANCEL:${point}`);
      expect(await snapshot()).toBe(before);
      injector.failAt = null;
      const done = await asCashier(() => reversal.cancelInvoice(sale.invoice.id, { reason: 'test' }, cashier()));
      expect(done.invoice.status).toBe('CANCELLED');
    });
  });

  describe.each(REPAYMENT_POINTS)('repayment fails at %s', (point) => {
    it('leaves no partial state', async () => {
      expect(await readers.outstanding()).toBeGreaterThan(0);
      const before = await snapshot();
      injector.failAt = { point, flow: 'REPAYMENT' };
      const dto = { idempotencyKey: randomUUID(), amount: 1, tender: TenderType.CASH };
      await expect(asCashier(() => customers.recordPayment(shop.customerId, dto, cashier()))).rejects.toThrow(`INJECTED_FAILURE:REPAYMENT:${point}`);
      expect(await snapshot()).toBe(before);
      injector.failAt = null;
      const done = await asCashier(() => customers.recordPayment(shop.customerId, dto, cashier()));
      expect('replayed' in done && done.replayed).toBe(false);
      const replay = await asCashier(() => customers.recordPayment(shop.customerId, dto, cashier()));
      expect('replayed' in replay && replay.replayed).toBe(true);
    });
  });

  it('after all injections the books still balance and stock equals the ledger', async () => {
    const txns = await run.system(() => prisma.ledgerTransaction.findMany({ where: { shopId: shop.shopId } }));
    const debit = txns.filter((t) => t.type === 'DEBIT').reduce((a, t) => a + num(t.amount), 0);
    const credit = txns.filter((t) => t.type === 'CREDIT').reduce((a, t) => a + num(t.amount), 0);
    expect(debit).toBeCloseTo(credit, 2);
    const items = await run.system(() => prisma.inventoryItem.findMany({ where: { shopId: shop.shopId }, include: { stockLedgerEntries: true, product: true } }));
    for (const item of items) {
      expect(num(item.onHand)).toBeCloseTo(item.stockLedgerEntries.reduce((a, e) => a + num(e.quantity), 0), 3);
      expect(num(item.product.currentStock)).toBeCloseTo(num(item.onHand), 3);
    }
    const udhar = await run.system(() => prisma.udharTransaction.findMany({ where: { customerId: shop.customerId } }));
    const derived = udhar.reduce((acc, t) => (t.type === 'CREDIT' ? acc + num(t.amount) : acc - num(t.amount)), 0);
    expect(await readers.outstanding()).toBeCloseTo(derived, 2);
    expect(Number(await redis.get(`stock:${shop.shopId}:${products.tea}`))).toBe(await readers.productStock(products.tea));
  });
});

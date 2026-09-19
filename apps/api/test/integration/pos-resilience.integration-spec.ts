/**
 * Roadmap POS-INV-003 targets 4 and 6 (cache and outbox), Phase 3 targets A-F
 * (accounting incl. the purchase side), Phase 5 (custom items) and the
 * authority rules (discount approval, inactive customers, shift ownership).
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CustomersService } from '../../src/customers/customers.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { InventoryCacheService } from '../../src/inventory/inventory-cache.service';
import { InventoryDomainService } from '../../src/inventory-domain/services/inventory-domain.service';
import { GrnIntegrationService } from '../../src/grn-domain/services/grn-integration.service';
import { PurchaseReturnInventoryService } from '../../src/purchase-return-domain/services/purchase-return-inventory.service';
import { OutboxRelayService } from '../../src/common/outbox/outbox-relay.service';
import { SystemEventsProcessor } from '../../src/common/outbox/system-events.processor';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { ReportExportService } from '../../src/analytics-domain/services/report-export.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { InvoiceMathEngine } from '@dukaanai/invoice-math';
import { actorFor, bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(300_000);

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

describe('POS resilience, accounting and custom items', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let customers: CustomersService;
  let shifts: ShiftsService;
  let cache: InventoryCacheService;
  let inventoryDomain: InventoryDomainService;
  let grn: GrnIntegrationService;
  let purchaseReturns: PurchaseReturnInventoryService;
  let relay: OutboxRelayService;
  let processor: SystemEventsProcessor;
  let dashboard: DashboardService;
  let exporter: ReportExportService;
  let redis: Redis;
  let jwt: JwtService;
  let shop: TestShop;
  let run: ReturnType<typeof tenantRunner>;
  let readers: ReturnType<typeof makeReaders>;
  const products: Record<string, string> = {};

  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);
  const owner = () => actorFor(shop, shop.ownerId, Role.OWNER);
  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const asOwner = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.ownerId, Role.OWNER, fn);
  const key = (productId: string) => `stock:${shop.shopId}:${productId}`;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    customers = app.get(CustomersService);
    shifts = app.get(ShiftsService);
    cache = app.get(InventoryCacheService);
    inventoryDomain = app.get(InventoryDomainService);
    grn = app.get(GrnIntegrationService);
    purchaseReturns = app.get(PurchaseReturnInventoryService);
    relay = app.get(OutboxRelayService);
    processor = app.get(SystemEventsProcessor);
    dashboard = app.get(DashboardService);
    exporter = app.get(ReportExportService);
    redis = app.get<Redis>(REDIS_CLIENT);
    jwt = app.get(JwtService);
    run = tenantRunner(app);
    shop = await createShop(app, 'rs', { creditLimit: 100000 });
    readers = makeReaders(app, shop);
    products.tea = await createProduct(app, shop, { key: 'TEA', reorderPoint: 3 });
    products.cess = await createProduct(app, shop, { key: 'CESS', sellingPrice: 1000, gstRate: 'TWENTYEIGHT', cessRate: 12 });
    products.service = await createProduct(app, shop, { key: 'SVC', type: 'SERVICE', sellingPrice: 200, costPrice: 0 });
    await receiveStock(app, shop, products.tea, 20);
    await receiveStock(app, shop, products.cess, 5);
    await asCashier(() => shifts.open({ openingCash: 500 }, cashier()));
    await asOwner(() => shifts.open({ openingCash: 0 }, owner()));
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // Cache (target 4)
  // ---------------------------------------------------------------------------

  it('Redis outage: sales still commit from the database, and the cache resyncs after the restart', async () => {
    const first = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, cashier()));
    expect(first.stock[0].productStockAfter).toBe(19);
    expect(await redis.get(key(products.tea))).toBe('19');

    redis.disconnect();
    await waitFor(async () => redis.status === 'end', 5_000);
    expect(await cache.tryDecrementStock(products.tea, 1, shop.shopId)).toBe('cache_miss');
    expect(await cache.getStock(products.tea, shop.shopId)).toBeNull();

    const during = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, cashier()));
    expect(during.stock[0].productStockAfter).toBe(17);
    expect(await readers.onHand(products.tea)).toBe(17);

    await redis.connect();
    await waitFor(async () => redis.status === 'ready', 10_000);
    // Stale or missing key: the next sale re-syncs from the authoritative value.
    const after = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, cashier()));
    expect(after.stock[0].productStockAfter).toBe(16);
    expect(await redis.get(key(products.tea))).toBe('16');

    // Poisoned cache (says 0) never rejects a sale the database allows; it is repaired.
    await redis.set(key(products.tea), '0', 'EX', 60);
    const repaired = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, cashier()));
    expect(repaired.stock[0].productStockAfter).toBe(15);
    expect(await redis.get(key(products.tea))).toBe('15');

    // A rejected sale restores its advisory decrement.
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 1 }] }, cashier()))).rejects.toMatchObject({ response: { code: 'ERR_PAYMENT_MISMATCH' } });
    expect(await redis.get(key(products.tea))).toBe('15');
  });

  // ---------------------------------------------------------------------------
  // Outbox (target 6)
  // ---------------------------------------------------------------------------

  it('outbox: a committed sale is relayed and processed once; a duplicate delivery is skipped; low stock is notified', async () => {
    // Bring tea to the reorder point (3) so the processor raises LOW_STOCK.
    const sale = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 12 }], payments: [{ tender: TenderType.UPI, amount: 1416 }] }, cashier()));
    expect(sale.stock[0].productStockAfter).toBe(3);
    const event = await run.system(() => prisma.outboxEvent.findFirstOrThrow({ where: { shopId: shop.shopId, entityId: sale.invoice.id, type: 'INVOICE_CREATED' } }));
    expect(event.status).toBe('PENDING');

    // The relay drains oldest-first in batches (other suites may have left a
    // backlog), so keep relaying until this event has been picked up and handled.
    const processed = await waitFor(async () => {
      await relay.relayEvents();
      return run.system(async () => {
        const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        const marker = await prisma.auditLog.count({ where: { shopId: shop.shopId, entity: 'OutboxEvent', entityId: event.id, action: 'SYSTEM_EVENT_PROCESSED' } });
        return row.status === 'DONE' && marker === 1;
      });
    }, 120_000);
    expect(processed).toBe(true);
    const lowStock = await run.system(() => prisma.notification.findMany({ where: { shopId: shop.shopId, type: 'LOW_STOCK', entityId: products.tea } }));
    expect(lowStock).toHaveLength(1);

    // Duplicate delivery of the same job id is a no-op.
    const job = { id: event.id, name: 'INVOICE_CREATED', opts: { jobId: event.id, attempts: 3 }, attemptsMade: 0, data: { eventId: event.id, correlationId: 'dup', shopId: shop.shopId, userId: shop.cashierId, payload: event.payload } } as unknown as Job;
    await expect(processor.process(job as never)).resolves.toEqual({ status: 'skipped-duplicate' });
    expect(await run.system(() => prisma.notification.count({ where: { shopId: shop.shopId, type: 'LOW_STOCK', entityId: products.tea } }))).toBe(1);
    expect(await run.system(() => prisma.auditLog.count({ where: { shopId: shop.shopId, entity: 'OutboxEvent', entityId: event.id } }))).toBe(1);

    // A failed transaction stages nothing.
    const outboxBefore = await run.system(() => prisma.outboxEvent.count({ where: { shopId: shop.shopId } }));
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 99 }], payments: [{ tender: TenderType.CASH, amount: 11682 }] }, cashier()))).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK' } });
    expect(await run.system(() => prisma.outboxEvent.count({ where: { shopId: shop.shopId } }))).toBe(outboxBefore);
  });

  // ---------------------------------------------------------------------------
  // Accounting (Phase 3 A-F) incl. the purchase side
  // ---------------------------------------------------------------------------

  it('INVENTORY at cost follows receipts, sales, returns, adjustments and supplier returns; every posting balances', async () => {
    const fresh = await createShop(app, 'acct');
    const r = makeReaders(app, fresh);
    const productId = await createProduct(app, fresh, { key: 'ACC', costPrice: 60, sellingPrice: 100 });
    const ownerActor = actorFor(fresh, fresh.ownerId, Role.OWNER);
    const asFreshOwner = <T>(fn: () => Promise<T>) => run.as(fresh.shopId, fresh.ownerId, Role.OWNER, fn);

    // Goods received on credit: 10 × 60
    await asFreshOwner(() => prisma.$transaction((tx) => grn.updateInventoryFromGrn(tx, fresh.shopId, { id: `GRN-${fresh.suffix}`, warehouseId: null, createdBy: fresh.ownerId, lines: [{ productId, acceptedQuantity: 10, unitPrice: 60 }] })));
    expect(await r.onHand(productId)).toBe(10);
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(600, 2);
    expect(await r.ledgerBalance('ACCOUNTS_PAYABLE')).toBeCloseTo(600, 2);
    // Idempotent: the same GRN posted again changes nothing.
    await asFreshOwner(() => prisma.$transaction((tx) => grn.updateInventoryFromGrn(tx, fresh.shopId, { id: `GRN-${fresh.suffix}`, warehouseId: null, createdBy: fresh.ownerId, lines: [{ productId, acceptedQuantity: 10, unitPrice: 60 }] })));
    expect(await r.onHand(productId)).toBe(10);
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(600, 2);

    // Sale of 2: COGS 120, INVENTORY 480, revenue 200, GST 36, cash 236
    await asFreshOwner(() => shifts.open({ openingCash: 0 }, ownerActor));
    const sale = await asFreshOwner(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, ownerActor));
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(480, 2);
    expect(await r.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(120, 2);
    expect(await r.ledgerBalance('SALES_REVENUE')).toBeCloseTo(200, 2);
    expect(await r.ledgerBalance('GST_PAYABLE')).toBeCloseTo(36, 2);
    expect(await r.ledgerBalance('CASH')).toBeCloseTo(236, 2);

    // Damage of 1 → INVENTORY_ADJUSTMENT 60
    const item = await asFreshOwner(() => inventoryDomain.ensureInventoryItem(productId));
    await asFreshOwner(() => inventoryDomain.adjustStock(item.id, 'DAMAGE', -1, fresh.ownerId));
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(420, 2);
    expect(await r.ledgerBalance('INVENTORY_ADJUSTMENT')).toBeCloseTo(60, 2);

    // Customer return of 1 → INVENTORY back 60, COGS 60, revenue -100, GST -18, cash -118
    await asFreshOwner(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: sale.invoice.id, items: [{ invoiceItemId: sale.invoice.items[0].id, quantity: 1 }], refund: { tender: TenderType.CASH } }, ownerActor));
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(480, 2);
    expect(await r.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(60, 2);
    expect(await r.ledgerBalance('SALES_REVENUE')).toBeCloseTo(100, 2);
    expect(await r.ledgerBalance('CASH')).toBeCloseTo(118, 2);

    // Supplier return of 3 → AP down 180, INVENTORY 300
    await asFreshOwner(() => prisma.$transaction((tx) => purchaseReturns.processInventoryReversal(tx, fresh.shopId, { id: `PR-${fresh.suffix}`, warehouseId: null, createdBy: fresh.ownerId, lines: [{ productId, returnQuantity: 3, unitPrice: 60 }] })));
    expect(await r.onHand(productId)).toBe(5);
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo(300, 2);
    expect(await r.ledgerBalance('ACCOUNTS_PAYABLE')).toBeCloseTo(420, 2);

    // INVENTORY balance == stock at cost, and Σ debits == Σ credits.
    expect(await r.ledgerBalance('INVENTORY')).toBeCloseTo((await r.onHand(productId))! * 60, 2);
    const txns = await run.system(() => prisma.ledgerTransaction.findMany({ where: { shopId: fresh.shopId } }));
    const debit = txns.filter((t) => t.type === 'DEBIT').reduce((a, t) => a + num(t.amount), 0);
    const credit = txns.filter((t) => t.type === 'CREDIT').reduce((a, t) => a + num(t.amount), 0);
    expect(debit).toBeCloseTo(credit, 2);

    // Dashboard inventory value agrees with the ledger.
    const summary = await asFreshOwner(() => dashboard.getSummary(fresh.shopId, fresh.ownerId));
    expect(summary.inventoryValue).toBeCloseTo(300, 2);
    expect(summary.todaySales).toBeCloseTo(118, 2);
  });

  it('service products post no cost of goods and never touch INVENTORY', async () => {
    const before = await readers.ledgerBalance('INVENTORY');
    const cogsBefore = await readers.ledgerBalance('COST_OF_GOODS');
    await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.service, quantity: 2 }], payments: [{ tender: TenderType.CARD, amount: 472 }] }, cashier()));
    expect(await readers.ledgerBalance('INVENTORY')).toBeCloseTo(before, 2);
    expect(await readers.ledgerBalance('COST_OF_GOODS')).toBeCloseTo(cogsBefore, 2);
  });

  // ---------------------------------------------------------------------------
  // Phase 5: custom items
  // ---------------------------------------------------------------------------

  it('custom items are priced, taxed, discounted, paid, ledgered, returned and reported without touching stock', async () => {
    const expected = InvoiceMathEngine.calculate({
      items: [
        { productId: products.tea, quantity: 1, unitPrice: 100, gstRateStr: 'EIGHTEEN', isInterState: false },
        { productId: 'custom:1', quantity: 2, unitPrice: 75.5, discountPercent: 10, gstRateStr: 'FIVE', isInterState: false },
      ],
    });
    const total = expected.finalTotal.toNumber();
    const teaBefore = await readers.onHand(products.tea);
    const cogsBefore = await readers.ledgerBalance('COST_OF_GOODS');

    const result = await asCashier(() =>
      billing.createInvoice(
        {
          idempotencyKey: randomUUID(),
          items: [
            { productId: products.tea, quantity: 1 },
            { custom: { name: 'Home delivery', unitPrice: 75.5, gstRate: 'FIVE' }, quantity: 2, discountPercent: 10 },
          ],
          payments: [{ tender: TenderType.CASH, amount: total }],
        },
        cashier(),
      ),
    );
    expect(num(result.invoice.totalAmount)).toBe(total);
    const custom = result.invoice.items.find((i) => i.isCustom)!;
    expect(custom.productId).toBeNull();
    expect(custom.productSku).toBe('CUSTOM');
    expect(custom.productName).toBe('Home delivery');
    expect(num(custom.sellingPrice)).toBe(75.5);
    expect(num(custom.taxableAmount)).toBe(expected.lines[1].taxableAmount.toNumber());
    expect(result.stock.map((s) => s.productId)).toEqual([products.tea]);
    expect(await readers.onHand(products.tea)).toBe(teaBefore! - 1);
    // COGS only for the catalogue line (tea costs 60).
    expect((await readers.ledgerBalance('COST_OF_GOODS')) - cogsBefore).toBeCloseTo(60, 2);

    // Return the custom line only: money back, no stock movement.
    const ledgerRowsBefore = await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId } }));
    const ret = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: result.invoice.id, items: [{ invoiceItemId: custom.id, quantity: 2 }], refund: { tender: TenderType.CASH } }, cashier()));
    expect(ret.stock).toHaveLength(0);
    expect(num(ret.invoice.totalAmount)).toBe(expected.lines[1].lineTotal.toDecimalPlaces(0).toNumber());
    expect(await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId } }))).toBe(ledgerRowsBefore);

    // Reporting includes it.
    const range = await asOwner(() => exporter.resolveRange(shop.shopId));
    let csv = '';
    await asOwner(() => exporter.streamInvoiceItemsCsv(shop.shopId, range, (chunk) => { csv += chunk; }));
    expect(csv).toContain('Home delivery');

    // Validation.
    const bad = (items: unknown[]) => asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: items as never, payments: [] }, cashier()));
    await expect(bad([{ custom: { name: '  ', unitPrice: 10, gstRate: 'FIVE' }, quantity: 1 }])).rejects.toMatchObject({ response: { code: 'CUSTOM_ITEM_INVALID' } });
    await expect(bad([{ custom: { name: 'x', unitPrice: 0, gstRate: 'FIVE' }, quantity: 1 }])).rejects.toMatchObject({ response: { code: 'CUSTOM_ITEM_INVALID' } });
    await expect(bad([{ productId: products.tea, custom: { name: 'x', unitPrice: 10, gstRate: 'FIVE' }, quantity: 1 }])).rejects.toMatchObject({ response: { code: 'CUSTOM_ITEM_INVALID' } });
    await expect(bad([{ custom: { name: 'x', unitPrice: 10, gstRate: 'FIVE' }, quantity: 0 }])).rejects.toMatchObject({ response: { code: 'ERR_INVALID_QUANTITY' } });
    await expect(bad([{ custom: { name: 'x', unitPrice: 10, gstRate: 'FIVE' }, quantity: 1, discountPercent: 150 }])).rejects.toMatchObject({ response: { code: 'ERR_INVALID_LINE_DISCOUNT' } });
  });

  it('cess is part of the authoritative math and persisted per line', async () => {
    const expected = InvoiceMathEngine.calculate({ items: [{ productId: products.cess, quantity: 1, unitPrice: 1000, gstRateStr: 'TWENTYEIGHT', cessRate: 12, isInterState: false }] });
    const result = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.cess, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: expected.finalTotal.toNumber() }] }, cashier()));
    expect(num(result.invoice.items[0].cessAmount)).toBe(120);
    expect(num(result.invoice.totalAmount)).toBe(1400);
    // Without cess the same payment is a mismatch: the server is the authority.
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.cess, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 1280 }] }, cashier()))).rejects.toMatchObject({ response: { code: 'ERR_PAYMENT_MISMATCH' } });
  });

  // ---------------------------------------------------------------------------
  // Authority rules
  // ---------------------------------------------------------------------------

  it('discounts above the cashier limit need a manager; the approver is stamped', async () => {
    const line = (discountPercent: number) => ({ productId: products.tea, quantity: 1, discountPercent });
    // 100 − 15% = 85 + 18% GST = 100.30 → ₹100 after round-off
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [line(15)], payments: [{ tender: TenderType.CASH, amount: 100 }] }, cashier()))).rejects.toMatchObject({
      response: { code: 'DISCOUNT_REQUIRES_APPROVAL', details: { maxPercent: 10, requestedPercent: 15 } },
    });
    await expect(asCashier(() => billing.calculateInvoice({ items: [line(15)] }, cashier()))).rejects.toMatchObject({ response: { code: 'DISCOUNT_REQUIRES_APPROVAL' } });
    await expect(
      asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [line(0)], discountType: 'PERCENTAGE', discountPercentage: 20, discountReason: 'friend', payments: [{ tender: TenderType.CASH, amount: 94 }] }, cashier())),
    ).rejects.toMatchObject({ response: { code: 'DISCOUNT_REQUIRES_APPROVAL' } });

    const within = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [line(10)], payments: [{ tender: TenderType.CASH, amount: 106 }] }, cashier()));
    expect(num(within.invoice.items[0].discountAmount)).toBe(10);

    const approved = await asOwner(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [line(0)], discountType: 'PERCENTAGE', discountPercentage: 20, discountReason: 'manager approved', payments: [{ tender: TenderType.CASH, amount: 94 }] }, owner()),
    );
    expect(approved.invoice.approvedBy).toBe(shop.ownerId);
    expect(num(approved.invoice.discountAmount)).toBe(20);
    // Line-level discounts are approvals too.
    // service product: ₹200 − 50 % = 100 + 18 % GST = 118 (no stock needed)
    const lineApproved = await asOwner(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.service, quantity: 1, discountPercent: 50 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, owner()));
    expect(lineApproved.invoice.approvedBy).toBe(shop.ownerId);
    expect(lineApproved.invoice.approvalTimestamp).not.toBeNull();
    const audit = await run.system(() => prisma.auditLog.findFirst({ where: { entity: 'Invoice', entityId: lineApproved.invoice.id, action: 'INVOICE_CREATED' } }));
    expect((audit?.afterData as { discount?: { maxLinePercent?: number } })?.discount?.maxLinePercent).toBe(50);
  });

  it('inactive customers cannot be billed or take payments; cashiers cannot bill on another cashier\'s shift', async () => {
    const inactive = await run.system(() => prisma.customer.create({ data: { name: 'Gone', phone: `8${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '1')}`, shopId: shop.shopId, isActive: false, creditLimit: 1000 } }));
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), customerId: inactive.id, items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, cashier()))).rejects.toMatchObject({ response: { code: 'CUSTOMER_INACTIVE' } });
    await expect(asCashier(() => customers.recordPayment(inactive.id, { idempotencyKey: randomUUID(), amount: 1, tender: TenderType.CASH, allowAdvance: true }, cashier()))).rejects.toMatchObject({ response: { code: 'CUSTOMER_INACTIVE' } });
    // Existing invoices of a customer who was deactivated later can still be returned and cancelled.
    const active = await run.system(() => prisma.customer.create({ data: { name: 'Later inactive', phone: `7${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '2')}`, shopId: shop.shopId, creditLimit: 1000 } }));
    const theirs = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), customerId: active.id, items: [{ productId: products.service, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 472 }] }, cashier()));
    await run.system(() => prisma.customer.update({ where: { id: active.id }, data: { isActive: false } }));
    const refund = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: theirs.invoice.id, items: [{ invoiceItemId: theirs.invoice.items[0].id, quantity: 1 }], refund: { tender: TenderType.CASH } }, cashier()));
    expect(num(refund.invoice.totalAmount)).toBe(236);
    await expect(asOwner(() => reversal.cancelInvoice(theirs.invoice.id, { reason: 'deactivated customer' }, owner()))).rejects.toMatchObject({ response: { code: 'INVOICE_NOT_CANCELLABLE' } });
    const second = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), customerId: active.id, items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, cashier()).catch((e) => e));
    expect((second as { response?: { code?: string } }).response?.code).toBe('CUSTOMER_INACTIVE');

    const ownerShift = await asOwner(() => shifts.current(owner()));
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), shiftId: ownerShift!.id, items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, cashier()))).rejects.toMatchObject({ response: { code: 'SHIFT_FORBIDDEN' } });
    const cashierShift = await asCashier(() => shifts.current(cashier()));
    const onOwn = await asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), shiftId: cashierShift!.id, items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, cashier()));
    expect(onOwn.shiftId).toBe(cashierShift!.id);
    const managerOnCashier = await asOwner(() => billing.createInvoice({ idempotencyKey: randomUUID(), shiftId: cashierShift!.id, items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, owner()));
    expect(managerOnCashier.shiftId).toBe(cashierShift!.id);
  });

  it('HTTP: custom items and the DTO guard on the wire', async () => {
    const token = jwt.sign({ sub: shop.cashierId, email: `cashier-${shop.suffix}@test.local`, role: 'CASHIER', shopId: shop.shopId, tokenVersion: 0 });
    const server = app.getHttpServer();
    const ok = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ custom: { name: 'Repair charge', unitPrice: 250, gstRate: 'EIGHTEEN' }, quantity: 1 }], payments: [{ tender: 'CASH', amount: 295 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.invoice.items[0].isCustom).toBe(true);
    expect(ok.body.invoice.items[0].productId).toBeNull();
    expect(ok.body.stock).toEqual([]);

    const neither = await request(server).post('/api/billing/invoice').set('Authorization', `Bearer ${token}`).send({ idempotencyKey: randomUUID(), items: [{ quantity: 1 }], payments: [] });
    expect(neither.status).toBe(400);
    const badPrice = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ custom: { name: 'x', unitPrice: -5, gstRate: 'EIGHTEEN' }, quantity: 1 }], payments: [] });
    expect(badPrice.status).toBe(400);
    const tooLarge = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1000000 }], payments: [] });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.code).toBe('ERR_AMOUNT_TOO_LARGE');
  });
});

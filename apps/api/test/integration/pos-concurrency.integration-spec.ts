/**
 * Roadmap POS-INV-002 step 5 (destructive verification) and Phase 4 target 4
 * (concurrency): the concurrency × stock × quantity matrix, the mixed-quantity
 * test, every listed edge case, concurrent returns / repayments / adjustments
 * / mixed flows, the multi-location aggregate and the first-request
 * bootstrap race of a brand-new shop.
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CustomersService } from '../../src/customers/customers.service';
import { InventoryDomainService } from '../../src/inventory-domain/services/inventory-domain.service';
import { InventoryMutationEngine, MutationType } from '../../src/inventory-domain/services/inventory-mutation.engine';
import { GrnIntegrationService } from '../../src/grn-domain/services/grn-integration.service';
import { actorFor, bootApp, createProduct, createShop, errorCode, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

jest.setTimeout(900_000);

/** (concurrent requests, opening stock, quantity per request) */
const MATRIX: Array<[number, number, number]> = [
  [10, 0, 1],
  [10, 1, 1],
  [10, 5, 1],
  [20, 10, 1],
  [50, 25, 1],
  [100, 10, 1],
  [100, 100, 1],
  [200, 100, 1],
  [200, 200, 1],
  [20, 10, 3],
];

describe('POS concurrency and destructive verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let customers: CustomersService;
  let inventoryDomain: InventoryDomainService;
  let engine: InventoryMutationEngine;
  let shop: TestShop;
  let run: ReturnType<typeof tenantRunner>;
  let readers: ReturnType<typeof makeReaders>;

  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);
  const owner = () => actorFor(shop, shop.ownerId, Role.OWNER);
  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const asOwner = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.ownerId, Role.OWNER, fn);

  const sale = (productId: string, quantity: number, actor = cashier(), extra: Record<string, unknown> = {}) =>
    run.as(shop.shopId, actor.userId, actor.role, () =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity }], payments: [{ tender: TenderType.CASH, amount: Number((quantity * 118).toFixed(2)) }], ...extra }, actor),
    );

  const settle = async <T>(promises: Array<Promise<T>>): Promise<{ ok: T[]; failed: unknown[] }> => {
    const results = await Promise.allSettled(promises);
    const ok: T[] = [];
    const failed: unknown[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') ok.push(r.value as T);
      else failed.push(r.reason);
    }
    return { ok, failed };
  };

  const assertStockInvariants = async (productId: string) => {
    const items = await run.system(() => prisma.inventoryItem.findMany({ where: { shopId: shop.shopId, productId, isDeleted: false }, include: { stockLedgerEntries: true } }));
    let total = 0;
    for (const item of items) {
      const ledgerSum = item.stockLedgerEntries.reduce((a, e) => a + num(e.quantity), 0);
      expect(num(item.onHand)).toBeCloseTo(ledgerSum, 3);
      expect(num(item.onHand)).toBeGreaterThanOrEqual(0);
      const sorted = [...item.stockLedgerEntries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      // balanceAfter of the last entry is the authoritative onHand
      expect(num(sorted[sorted.length - 1]?.balanceAfter)).toBeCloseTo(num(item.onHand), 3);
      total += num(item.onHand);
    }
    expect(await readers.productStock(productId)).toBeCloseTo(total, 3);
    const logs = await run.system(() => prisma.inventoryLog.findMany({ where: { shopId: shop.shopId, productId } }));
    const logSum = logs.reduce((a, l) => a + num(l.quantityChange), 0);
    expect(logSum).toBeCloseTo(total, 3);
  };

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    customers = app.get(CustomersService);
    inventoryDomain = app.get(InventoryDomainService);
    engine = app.get(InventoryMutationEngine);
    run = tenantRunner(app);
    shop = await createShop(app, 'cc', { creditLimit: 10_000_000 });
    readers = makeReaders(app, shop);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe.each(MATRIX)('%i concurrent sales, stock %i, quantity %i', (concurrency, stock, quantity) => {
    it('never oversells, never goes negative, ledger and projection agree', async () => {
      const productId = await createProduct(app, shop, { key: `M${concurrency}-${stock}-${quantity}` });
      if (stock > 0) await receiveStock(app, shop, productId, stock);
      const expectedOk = Math.min(concurrency, Math.floor(stock / quantity));

      const { ok, failed } = await settle(Array.from({ length: concurrency }, (_, i) => sale(productId, quantity, i % 2 ? cashier() : owner())));
      expect(ok).toHaveLength(expectedOk);
      expect(failed).toHaveLength(concurrency - expectedOk);
      for (const f of failed) expect(errorCode(f)).toBe('INSUFFICIENT_STOCK');

      expect(await readers.onHand(productId)).toBe(stock > 0 ? stock - expectedOk * quantity : null);
      expect(await readers.productStock(productId)).toBe(stock - expectedOk * quantity);
      expect(new Set(ok.map((r) => r.invoice.invoiceNumber)).size).toBe(expectedOk);
      const sales = await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId, movementType: 'SALE', inventoryItem: { productId } } }));
      expect(sales).toBe(expectedOk);
      await assertStockInvariants(productId);
    });
  });

  it('mixed quantities against 20 units: Σ successful ≤ 20 and final stock = 20 − Σ successful', async () => {
    const productId = await createProduct(app, shop, { key: 'MIX' });
    await receiveStock(app, shop, productId, 20);
    const requests = [5, 2, 7, 10, 1];
    const { ok, failed } = await settle(requests.map((q) => sale(productId, q)));
    const sold = ok.reduce((a, r) => a + num(r.invoice.items[0].quantity), 0);
    expect(sold).toBeLessThanOrEqual(20);
    expect(ok.length + failed.length).toBe(requests.length);
    for (const f of failed) expect(errorCode(f)).toBe('INSUFFICIENT_STOCK');
    expect(await readers.onHand(productId)).toBe(20 - sold);
    await assertStockInvariants(productId);
  });

  it('quantity edge cases: exact stock, stock + 1, zero, negative, decimal, huge', async () => {
    const pcs = await createProduct(app, shop, { key: 'EDGE' });
    const kg = await createProduct(app, shop, { key: 'EDGEKG', unit: 'KG', sellingPrice: 80, gstRate: 'FIVE' });
    await receiveStock(app, shop, pcs, 7);
    await receiveStock(app, shop, kg, 2.5);

    await expect(sale(pcs, 8)).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK', details: { availableQty: 7 } } });
    const exact = await sale(pcs, 7);
    expect(num(exact.invoice.items[0].quantity)).toBe(7);
    expect(await readers.onHand(pcs)).toBe(0);
    await expect(sale(pcs, 1)).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK', details: { availableQty: 0 } } });

    await expect(sale(pcs, 0)).rejects.toMatchObject({ response: { code: 'ERR_INVALID_QUANTITY' } });
    await expect(sale(pcs, -1)).rejects.toMatchObject({ response: { code: 'ERR_INVALID_QUANTITY' } });
    await expect(sale(pcs, 1_000_000)).rejects.toMatchObject({ response: { code: 'ERR_AMOUNT_TOO_LARGE' } });
    await expect(sale(pcs, 10_000)).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK' } });

    const weighed = await asCashier(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: kg, quantity: 1.25 }], payments: [{ tender: TenderType.CASH, amount: 105 }] }, cashier()),
    );
    expect(num(weighed.invoice.items[0].quantity)).toBe(1.25);
    expect(await readers.onHand(kg)).toBe(1.25);
    await assertStockInvariants(pcs);
    await assertStockInvariants(kg);
  });

  it('product edge cases: missing, deleted, inactive, other shop, service; wrong tenant / location at the engine', async () => {
    const other = await createShop(app, 'cc2');
    const foreign = await createProduct(app, other, { key: 'FOREIGN' });
    const deleted = await createProduct(app, shop, { key: 'DEL' });
    await run.system(() => prisma.product.update({ where: { id: deleted }, data: { isDeleted: true, deletedAt: new Date() } }));
    const inactive = await createProduct(app, shop, { key: 'INACT', isActive: false });
    const service = await createProduct(app, shop, { key: 'SVC', type: 'SERVICE', sellingPrice: 100, costPrice: 0 });

    for (const id of ['does-not-exist', deleted, inactive, foreign]) {
      await expect(sale(id, 1)).rejects.toMatchObject({ response: { code: 'PRODUCT_NOT_FOUND' } });
    }
    const svc = await sale(service, 3);
    expect(svc.stock).toHaveLength(0);
    expect(await run.system(() => prisma.inventoryItem.count({ where: { productId: service } }))).toBe(0);

    const local = await createProduct(app, shop, { key: 'LOCAL' });
    await receiveStock(app, shop, local, 5);
    // Cross-tenant: our shop id with the other shop's product, and their location with our product.
    await expect(
      run.system(() => prisma.$transaction((tx) => engine.mutateStock(tx, { shopId: shop.shopId, locationId: shop.saleLocationId, productId: foreign, quantity: 1, mutationType: MutationType.SALE, referenceId: 'x', performedBy: shop.ownerId }))),
    ).rejects.toMatchObject({ code: 'TENANT_VIOLATION' });
    await expect(
      run.system(() => prisma.$transaction((tx) => engine.mutateStock(tx, { shopId: shop.shopId, locationId: other.saleLocationId, productId: local, quantity: 1, mutationType: MutationType.SALE, referenceId: 'x', performedBy: shop.ownerId }))),
    ).rejects.toMatchObject({ code: 'LOCATION_INVALID' });
    await expect(
      run.system(() => prisma.$transaction((tx) => engine.mutateStock(tx, { shopId: shop.shopId, locationId: shop.saleLocationId, productId: local, quantity: 0, mutationType: MutationType.SALE, referenceId: 'x', performedBy: shop.ownerId }))),
    ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    expect(await readers.onHand(local)).toBe(5);
  });

  it('a brand-new shop: concurrent first sales create exactly one default warehouse, bin and inventory item', async () => {
    const fresh = await createShop(app, 'boot', { resolveLocation: false });
    const legacy = await createProduct(app, fresh, { key: 'LEGACY', legacyStock: 10 });
    const actor = actorFor(fresh, fresh.ownerId, Role.OWNER);
    const { ok, failed } = await settle(
      Array.from({ length: 8 }, () =>
        run.as(fresh.shopId, fresh.ownerId, Role.OWNER, () =>
          billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: legacy, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, actor),
        ),
      ),
    );
    expect(failed).toEqual([]);
    expect(ok).toHaveLength(8);
    const [warehouses, bins, items, opening] = await run.system(() =>
      Promise.all([
        prisma.warehouse.count({ where: { shopId: fresh.shopId, code: 'DEFAULT' } }),
        prisma.location.count({ where: { shopId: fresh.shopId, code: 'DEFAULT_BIN' } }),
        prisma.inventoryItem.findMany({ where: { shopId: fresh.shopId, productId: legacy } }),
        prisma.stockLedgerEntry.count({ where: { shopId: fresh.shopId, movementType: 'OPENING_BALANCE' } }),
      ]),
    );
    expect(warehouses).toBe(1);
    expect(bins).toBe(1);
    expect(items).toHaveLength(1);
    expect(opening).toBe(1);
    expect(num(items[0].onHand)).toBe(2);
    expect(num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: legacy } }))).currentStock)).toBe(2);
  });

  it('a legacy product opened through the inventory endpoint keeps its stock (bootstrap on first touch, not only on first sale)', async () => {
    const legacy = await createProduct(app, shop, { key: 'LEGACY2', legacyStock: 7 });
    const item = await asOwner(() => inventoryDomain.ensureInventoryItem(legacy));
    expect(num(item.onHand)).toBe(7);
    expect(await readers.onHand(legacy)).toBe(7);
    expect(await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId, inventoryItemId: item.id, movementType: 'OPENING_BALANCE' } }))).toBe(1);
    const s = await sale(legacy, 3);
    expect(s.stock[0].balanceAfter).toBe(4);
    await assertStockInvariants(legacy);
  });

  it('two locations: Product.currentStock is the sum of both while the POS sells only from the sale location', async () => {
    const productId = await createProduct(app, shop, { key: 'MULTI' });
    const warehouse = await run.system(() => prisma.warehouse.create({ data: { shopId: shop.shopId, code: `WH2-${shop.suffix}`, name: 'Back store', type: 'DISTRIBUTION_CENTER' } }));
    const bin = await run.system(() => prisma.location.create({ data: { shopId: shop.shopId, warehouseId: warehouse.id, type: 'BIN', code: 'B1', path: `/${warehouse.id}/B1`, depth: 0 } }));
    await receiveStock(app, shop, productId, 5);
    await receiveStock(app, shop, productId, 7, bin.id);
    expect(await readers.onHand(productId)).toBe(5);
    expect(await readers.onHand(productId, bin.id)).toBe(7);
    expect(await readers.productStock(productId)).toBe(12);

    const { ok, failed } = await settle(Array.from({ length: 8 }, () => sale(productId, 1)));
    expect(ok).toHaveLength(5);
    for (const f of failed) expect(errorCode(f)).toBe('INSUFFICIENT_STOCK');
    expect(await readers.onHand(productId)).toBe(0);
    expect(await readers.onHand(productId, bin.id)).toBe(7);
    expect(await readers.productStock(productId)).toBe(7);
    await assertStockInvariants(productId);
  });

  it('concurrent returns of one invoice: exactly one succeeds per unit, over-returns are rejected', async () => {
    const productId = await createProduct(app, shop, { key: 'RET' });
    await receiveStock(app, shop, productId, 10);
    const original = await sale(productId, 4);
    const lineId = original.invoice.items[0].id;
    const { ok, failed } = await settle(
      Array.from({ length: 6 }, () =>
        asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: original.invoice.id, items: [{ invoiceItemId: lineId, quantity: 1 }], refund: { tender: TenderType.UPI } }, cashier())),
      ),
    );
    expect(ok).toHaveLength(4);
    expect(failed).toHaveLength(2);
    for (const f of failed) expect(['RETURN_QTY_EXCEEDS', 'INVOICE_NOT_RETURNABLE']).toContain(errorCode(f));
    expect(await readers.onHand(productId)).toBe(10);
    expect(num((await run.system(() => prisma.invoiceItem.findUniqueOrThrow({ where: { id: lineId } }))).returnedQuantity)).toBe(4);
    await assertStockInvariants(productId);
  });

  it('concurrent adjustments on one item are all applied atomically', async () => {
    const productId = await createProduct(app, shop, { key: 'ADJ' });
    await receiveStock(app, shop, productId, 50);
    const item = await asOwner(() => inventoryDomain.ensureInventoryItem(productId));
    const deltas = [5, -3, 10, -7, 2, -1, 4, -4, 6, -2];
    const { failed } = await settle(deltas.map((d) => asOwner(() => inventoryDomain.adjustStock(item.id, d < 0 ? 'DAMAGE' : 'CORRECTION', d, shop.ownerId))));
    expect(failed).toEqual([]);
    expect(await readers.onHand(productId)).toBe(50 + deltas.reduce((a, b) => a + b, 0));
    await assertStockInvariants(productId);
  });

  it('concurrent credit sales, repayments and returns for one customer keep the balance equal to its ledger', async () => {
    const productId = await createProduct(app, shop, { key: 'CUST' });
    await receiveStock(app, shop, productId, 500);
    const creditSale = () =>
      asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), customerId: shop.customerId, items: [{ productId, quantity: 1 }], payments: [], udharAmount: 118 }, cashier()));
    const repay = () => asCashier(() => customers.recordPayment(shop.customerId, { idempotencyKey: randomUUID(), amount: 10, tender: TenderType.CASH, allowAdvance: true }, cashier()));
    const seeded = await creditSale();
    const errors: string[] = [];
    for (let round = 0; round < 12; round++) {
      const { failed } = await settle<unknown>([creditSale(), repay(), creditSale(), repay(), asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: seeded.invoice.id, refund: { tender: TenderType.UPI } }, cashier()))]);
      for (const f of failed) {
        const code = errorCode(f);
        if (code !== 'INVOICE_NOT_RETURNABLE') errors.push(`${code}: ${(f as Error).message}`);
      }
    }
    expect(errors).toEqual([]);
    const udhar = await run.system(() => prisma.udharTransaction.findMany({ where: { customerId: shop.customerId } }));
    const derived = udhar.reduce((acc, t) => (t.type === 'CREDIT' ? acc + num(t.amount) : acc - num(t.amount)), 0);
    expect(await readers.outstanding()).toBeCloseTo(derived, 2);
    await assertStockInvariants(productId);
  });

  it('sales, returns, cancellations, receipts and adjustments of one product overlap without a single deadlock failure', async () => {
    // Sales queue on the invoice number lock, returns on the return number
    // lock, receipts and adjustments on nothing: the only shared lock is the
    // product row, which every flow must take before inserting rows that
    // reference the product.
    const productId = await createProduct(app, shop, { key: 'XFLOW', costPrice: 10, sellingPrice: 100 });
    await receiveStock(app, shop, productId, 200);
    const item = await asOwner(() => inventoryDomain.ensureInventoryItem(productId));
    const grnService = app.get(GrnIntegrationService);
    const errors: string[] = [];
    for (let round = 0; round < 25; round++) {
      const seed = await sale(productId, 2, owner());
      const { failed, ok } = await settle<unknown>([
        sale(productId, 1, owner()),
        asOwner(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: seed.invoice.id, refund: { tender: TenderType.UPI } }, owner())),
        sale(productId, 1, cashier()),
        asOwner(() => prisma.$transaction((tx) => grnService.updateInventoryFromGrn(tx, shop.shopId, { id: `GRN-x-${round}-${shop.suffix}`, warehouseId: null, createdBy: shop.ownerId, lines: [{ productId, acceptedQuantity: 1, unitPrice: 10 }] }))),
        asOwner(() => inventoryDomain.adjustStock(item.id, 'DAMAGE', -1, shop.ownerId)),
      ]);
      for (const f of failed) errors.push(`${errorCode(f)}: ${(f as Error).message}`);
      if (failed.length === 0) expect(ok).toHaveLength(5);
    }
    expect(errors).toEqual([]);
    // 200 + 25×(−2 +2 −1 −1 +1 −1) = 200 − 50
    expect(await readers.onHand(productId)).toBe(150);
    await assertStockInvariants(productId);
  });

  it('same idempotency key fired concurrently produces one invoice and one stock movement', async () => {
    const productId = await createProduct(app, shop, { key: 'IDEM' });
    await receiveStock(app, shop, productId, 10);
    const key = randomUUID();
    const dto = { idempotencyKey: key, items: [{ productId, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] };
    const { ok, failed } = await settle(Array.from({ length: 6 }, () => asCashier(() => billing.createInvoice(dto, cashier()))));
    expect(failed).toEqual([]);
    expect(new Set(ok.map((r) => r.invoice.id)).size).toBe(1);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await readers.onHand(productId)).toBe(9);
    expect(await run.system(() => prisma.stockLedgerEntry.count({ where: { shopId: shop.shopId, inventoryItem: { productId }, movementType: 'SALE' } }))).toBe(1);
  });

  it('books balance across everything above', async () => {
    const txns = await run.system(() => prisma.ledgerTransaction.findMany({ where: { shopId: shop.shopId } }));
    const debit = txns.filter((t) => t.type === 'DEBIT').reduce((a, t) => a + num(t.amount), 0);
    const credit = txns.filter((t) => t.type === 'CREDIT').reduce((a, t) => a + num(t.amount), 0);
    expect(debit).toBeCloseTo(credit, 2);
    const balances = await run.system(() => prisma.ledgerAccountBalance.findMany({ where: { shopId: shop.shopId } }));
    for (const b of balances) {
      const last = await run.system(() => prisma.ledgerTransaction.findFirst({ where: { shopId: shop.shopId, account: b.account }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
      expect(num(last?.balanceAfter)).toBeCloseTo(num(b.balance), 2);
    }
  });
});

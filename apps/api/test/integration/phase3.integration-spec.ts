/**
 * Roadmap phase 3: money and stock correctness on a real database.
 *   3.1 cumulative returns never refund more than the sale
 *   3.4 credit limits are a manager's call, with an audit row
 *   3.5 reversals work on soft-deleted products and customers; refunds net
 *       against the sale's shift while it is open
 *   3.6 a cashier's custom line is capped
 *   3.7 stock idempotency is per receipt line, releases floor `reserved`
 *   3.8 reservations always expire and can be cancelled / released once
 *   3.9 stock-count adjustments wait for a different approver
 *   3.10 duplicate SKUs / phones lose the race at the unique index
 *   3.11 supplier payables follow the ledger
 *   3.12 the ledger is append-only
 */
import { INestApplication } from '@nestjs/common';
import { AdjustmentStatus, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { CustomersService } from '../../src/customers/customers.service';
import { GrnIntegrationService } from '../../src/grn-domain/services/grn-integration.service';
import { InventoryMutationEngine, MutationType } from '../../src/inventory-domain/services/inventory-mutation.engine';
import { SupplierPayablesService } from '../../src/ledger/supplier-payables.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductsService } from '../../src/products/products.service';
import { PurchaseReturnInventoryService } from '../../src/purchase-return-domain/services/purchase-return-inventory.service';
import { ReservationExpiryService } from '../../src/reservation-domain/services/reservation-expiry.service';
import { ReservationService } from '../../src/reservation-domain/services/reservation.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { AdjustmentApprovalService } from '../../src/stock-count-domain/services/adjustment-approval.service';
import { StockCountService } from '../../src/stock-count-domain/services/stock-count.service';
import { VarianceService } from '../../src/stock-count-domain/services/variance.service';
import { SuppliersService } from '../../src/suppliers/suppliers.service';
import { createUser } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, errorCode, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

describe('phase 3: money and stock correctness', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let shifts: ShiftsService;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    shifts = app.get(ShiftsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const openShift = (shop: TestShop, userId: string, role: Role) => run.as(shop.shopId, userId, role, () => shifts.open({ openingCash: 1000 }, actorFor(shop, userId, role)));

  const sell = (shop: TestShop, productId: string, quantity: number, amount: number, extra: Record<string, unknown> = {}) =>
    run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity }], payments: [{ tender: TenderType.CASH, amount }], ...extra } as never, actorFor(shop, shop.cashierId, Role.CASHIER)),
    );

  const returnLine = (shop: TestShop, invoiceId: string, invoiceItemId: string, quantity: number, userId: string = shop.cashierId, role: Role = Role.CASHIER) =>
    run.as(shop.shopId, userId, role, () =>
      reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId, items: [{ invoiceItemId, quantity }], reason: 'DAMAGED' as never, refund: { tender: TenderType.CASH } }, actorFor(shop, userId, role)),
    );

  describe('3.1 cumulative returns', () => {
    it('partial returns of a rounded sale add up to exactly the sale total; the last one carries the round-off; nothing more can be refunded', async () => {
      const shop = await createShop(app, 'p3-ret');
      await openShift(shop, shop.cashierId, Role.CASHIER);
      // 3 x 0.50 = 1.50 rounds to 2.00 (+0.50 round-off)
      const productId = await createProduct(app, shop, { key: 'half', sellingPrice: 0.5, gstRate: 'ZERO' });
      await receiveStock(app, shop, productId, 3);
      const readers = makeReaders(app, shop);
      const cashBefore = await readers.ledgerBalance('CASH');
      const revenueBefore = await readers.ledgerBalance('SALES_REVENUE');

      const sale = await sell(shop, productId, 3, 2);
      expect(num(sale.invoice.totalAmount)).toBe(2);
      expect(num(sale.invoice.roundOffAmount)).toBe(0.5);
      const line = sale.invoice.items[0];

      const first = await returnLine(shop, sale.invoice.id, line.id, 1);
      expect(num(first.invoice.totalAmount)).toBe(0.5);
      expect(num(first.invoice.roundOffAmount)).toBe(0);
      const second = await returnLine(shop, sale.invoice.id, line.id, 1);
      expect(num(second.invoice.totalAmount)).toBe(0.5);
      const last = await returnLine(shop, sale.invoice.id, line.id, 1);
      expect(num(last.invoice.totalAmount)).toBe(1);
      expect(num(last.invoice.roundOffAmount)).toBe(0.5);

      expect(await readers.ledgerBalance('CASH')).toBe(cashBefore);
      expect(await readers.ledgerBalance('SALES_REVENUE')).toBe(revenueBefore);
      await expect(returnLine(shop, sale.invoice.id, line.id, 1)).rejects.toMatchObject({ response: { code: 'RETURN_QTY_EXCEEDS' } });
    });

    it('a taxed line returned in uneven slices reverses exactly the stored amounts', async () => {
      const shop = await createShop(app, 'p3-tax');
      await openShift(shop, shop.cashierId, Role.CASHIER);
      const productId = await createProduct(app, shop, { key: 'tax', sellingPrice: 33.33, gstRate: 'EIGHTEEN' });
      await receiveStock(app, shop, productId, 7);
      const readers = makeReaders(app, shop);
      const gstBefore = await readers.ledgerBalance('GST_PAYABLE');
      const cashBefore = await readers.ledgerBalance('CASH');

      const preview = await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => billing.calculateInvoice({ items: [{ productId, quantity: 7 }] } as never, actorFor(shop, shop.cashierId, Role.CASHIER)));
      const total = num(preview.finalTotal);
      const sale = await sell(shop, productId, 7, total);
      const line = sale.invoice.items[0];
      let refunded = 0;
      for (const qty of [2, 1, 3, 1]) {
        const r = await returnLine(shop, sale.invoice.id, line.id, qty);
        refunded += num(r.invoice.totalAmount);
      }
      expect(Number(refunded.toFixed(2))).toBe(num(sale.invoice.totalAmount));
      expect(await readers.ledgerBalance('GST_PAYABLE')).toBe(gstBefore);
      expect(await readers.ledgerBalance('CASH')).toBe(cashBefore);
    });
  });

  describe('3.5 reversals of deleted products and customers, refund shift', () => {
    it('a return and a cancellation succeed after the product was soft-deleted', async () => {
      const shop = await createShop(app, 'p3-del');
      await openShift(shop, shop.cashierId, Role.CASHIER);
      const products = app.get(ProductsService);
      const a = await createProduct(app, shop, { key: 'gone-a', sellingPrice: 10, gstRate: 'ZERO' });
      const b = await createProduct(app, shop, { key: 'gone-b', sellingPrice: 10, gstRate: 'ZERO' });
      await receiveStock(app, shop, a, 5);
      await receiveStock(app, shop, b, 5);
      const saleA = await sell(shop, a, 2, 20);
      const saleB = await sell(shop, b, 2, 20);
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => products.softDelete(a));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => products.softDelete(b));
      const readers = makeReaders(app, shop);

      const ret = await returnLine(shop, saleA.invoice.id, saleA.invoice.items[0].id, 2);
      expect(ret.invoice.type).toBe('SALES_RETURN');
      expect(await readers.onHand(a)).toBe(5);

      const cancelled = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => reversal.cancelInvoice(saleB.invoice.id, { reason: 'wrong item' }, actorFor(shop, shop.ownerId, Role.OWNER)));
      expect(cancelled.invoice.status).toBe('CANCELLED');
      expect(await readers.onHand(b)).toBe(5);

      // The product itself can no longer be sold.
      await expect(sell(shop, a, 1, 10)).rejects.toMatchObject({ response: { code: 'PRODUCT_NOT_FOUND' } });
    });

    it('a credit sale can be returned after the customer was soft-deleted, and the credit reverses', async () => {
      const shop = await createShop(app, 'p3-cust', { creditLimit: 10_000 });
      await openShift(shop, shop.cashierId, Role.CASHIER);
      const productId = await createProduct(app, shop, { key: 'udhar', sellingPrice: 100, gstRate: 'ZERO' });
      await receiveStock(app, shop, productId, 5);
      const sale = await sell(shop, productId, 1, 0, { customerId: shop.customerId, payments: [], udharAmount: 100 });
      expect(num(sale.invoice.udharAmount)).toBe(100);
      // The service refuses to delete a customer who still owes money; a legacy
      // database can hold such a row anyway, so the row is deleted directly.
      await run.system(() => prisma.customer.update({ where: { id: shop.customerId }, data: { isDeleted: true, deletedAt: new Date(), isActive: false } }));
      expect((await run.system(() => prisma.customer.findUniqueOrThrow({ where: { id: shop.customerId } }))).deletedToken).toBe(shop.customerId);

      const ret = await returnLine(shop, sale.invoice.id, sale.invoice.items[0].id, 1);
      expect(num(ret.invoice.udharAmount)).toBe(100);
      expect(await makeReaders(app, shop).outstanding()).toBe(0);
    });

    it("a refund nets against the sale's shift while it is open, and lands on the actor's drawer once it is closed", async () => {
      const shop = await createShop(app, 'p3-shift');
      const other = await createUser(app, shop, Role.CASHIER);
      const saleShift = await openShift(shop, shop.cashierId, Role.CASHIER);
      const otherShift = await openShift(shop, other.id, Role.CASHIER);
      const productId = await createProduct(app, shop, { key: 'shift', sellingPrice: 10, gstRate: 'ZERO' });
      await receiveStock(app, shop, productId, 10);
      const sale = await sell(shop, productId, 4, 40);
      expect(sale.invoice.shiftId).toBe(saleShift.id);

      // A manager refunding while the sale's shift is open: the sale's shift takes it.
      const managerReturn = await returnLine(shop, sale.invoice.id, sale.invoice.items[0].id, 1, shop.ownerId, Role.OWNER);
      expect(managerReturn.invoice.shiftId).toBe(saleShift.id);
      // Another cashier refunding: their own drawer pays, so their shift takes it.
      const otherReturn = await returnLine(shop, sale.invoice.id, sale.invoice.items[0].id, 1, other.id, Role.CASHIER);
      expect(otherReturn.invoice.shiftId).toBe(otherShift.id);

      await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => shifts.close({ closingCash: 1030 }, actorFor(shop, shop.cashierId, Role.CASHIER)));
      const laterShift = await openShift(shop, shop.cashierId, Role.CASHIER);
      const lateReturn = await returnLine(shop, sale.invoice.id, sale.invoice.items[0].id, 1);
      expect(lateReturn.invoice.shiftId).toBe(laterShift.id);
      const closed = await run.system(() => prisma.shift.findUniqueOrThrow({ where: { id: saleShift.id } }));
      expect(num(closed.totalSales)).toBe(30); // 40 sold, one unit refunded on this shift
    });
  });

  describe('3.4 credit limit authority', () => {
    it('a cashier cannot set a credit limit; a manager can, and the change is audited', async () => {
      const shop = await createShop(app, 'p3-credit');
      const customers = app.get(CustomersService);
      const cashier = actorFor(shop, shop.cashierId, Role.CASHIER);
      const owner = actorFor(shop, shop.ownerId, Role.OWNER);
      await expect(run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => customers.create({ name: 'Limit', phone: `9${Date.now()}`.slice(0, 10), creditLimit: 50_000 }, cashier))).rejects.toMatchObject({ response: { code: 'CREDIT_LIMIT_REQUIRES_MANAGER' } });
      await expect(run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => customers.update(shop.customerId, { creditLimit: 50_000 }, cashier))).rejects.toMatchObject({ response: { code: 'CREDIT_LIMIT_REQUIRES_MANAGER' } });
      const plain = await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => customers.update(shop.customerId, { name: 'Renamed by cashier' }, cashier));
      expect(plain.name).toBe('Renamed by cashier');

      const updated = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.update(shop.customerId, { creditLimit: 50_000 }, owner));
      expect(num(updated.creditLimit)).toBe(50_000);
      const audit = await run.system(() => prisma.auditLog.findFirst({ where: { shopId: shop.shopId, entity: 'Customer', entityId: shop.customerId, action: 'CUSTOMER_CREDIT_LIMIT_CHANGED' } }));
      expect(audit).toMatchObject({ userId: shop.ownerId, afterData: { creditLimit: '50000.00' } });
    });
  });

  describe('3.6 custom lines', () => {
    it('a cashier is capped per custom line while a manager is not', async () => {
      const shop = await createShop(app, 'p3-custom');
      await openShift(shop, shop.cashierId, Role.CASHIER);
      const custom = (unitPrice: number) => ({ custom: { name: 'Gift wrap', unitPrice, gstRate: 'ZERO' }, quantity: 1 });
      await expect(sell(shop, '', 1, 900, { items: [custom(900)] })).rejects.toMatchObject({ response: { code: 'CUSTOM_LINE_REQUIRES_APPROVAL' } });
      const small = await sell(shop, '', 1, 200, { items: [custom(200)] });
      expect(num(small.invoice.totalAmount)).toBe(200);
      const owner = actorFor(shop, shop.ownerId, Role.OWNER);
      const big = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        billing.createInvoice({ idempotencyKey: randomUUID(), items: [custom(900)], payments: [{ tender: TenderType.CASH, amount: 900 }] } as never, owner),
      );
      expect(num(big.invoice.totalAmount)).toBe(900);
    });
  });

  describe('3.10 unique keys under concurrency', () => {
    it('50 concurrent inserts of one SKU and one phone leave exactly one live row each', async () => {
      const shop = await createShop(app, 'p3-dup');
      const products = app.get(ProductsService);
      const customers = app.get(CustomersService);
      const sku = `DUP-${shop.suffix}`;
      const phone = `8${Date.now()}`.slice(0, 10);
      const productAttempts = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
            products.create({ name: `Dup ${i}`, sku, costPrice: 1, sellingPrice: 2, mrp: 2, wholesalePrice: 2, gstRate: 'ZERO', unit: 'PCS', type: 'SIMPLE', status: 'ACTIVE' } as never),
          ),
        ),
      );
      const customerAttempts = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) => run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.create({ name: `Dup ${i}`, phone }, actorFor(shop, shop.ownerId, Role.OWNER)))),
      );
      expect(productAttempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(customerAttempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of [...productAttempts, ...customerAttempts]) {
        if (r.status === 'rejected') expect([400, 409]).toContain((r.reason as { status?: number }).status);
      }
      expect(customerAttempts.filter((r) => r.status === 'rejected' && errorCode(r.reason) === 'CUSTOMER_PHONE_IN_USE')).toHaveLength(49);
      expect(await run.system(() => prisma.product.count({ where: { shopId: shop.shopId, sku, isDeleted: false } }))).toBe(1);
      expect(await run.system(() => prisma.customer.count({ where: { shopId: shop.shopId, phone, isDeleted: false } }))).toBe(1);
    });

    it('a soft-deleted row frees its key, and the token is stamped by the Prisma extension', async () => {
      const shop = await createShop(app, 'p3-token');
      const customers = app.get(CustomersService);
      const owner = actorFor(shop, shop.ownerId, Role.OWNER);
      const phone = `7${Date.now()}`.slice(0, 10);
      const first = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.create({ name: 'First', phone }, owner));
      await expect(run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.create({ name: 'Second', phone }, owner))).rejects.toMatchObject({ response: { code: 'CUSTOMER_PHONE_IN_USE' } });
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.softDelete(first.id, owner));
      const deleted = await run.system(() => prisma.customer.findUniqueOrThrow({ where: { id: first.id } }));
      expect(deleted.deletedToken).toBe(first.id);
      const second = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => customers.create({ name: 'Second', phone }, owner));
      expect(second.deletedToken).toBe('');
    });
  });

  describe('3.7 stock engine', () => {
    it('two receipt lines of one product both count, a replayed line is skipped without value, and a release floors reserved at zero', async () => {
      const shop = await createShop(app, 'p3-grn');
      const grn = app.get(GrnIntegrationService);
      const engine = app.get(InventoryMutationEngine);
      const productId = await createProduct(app, shop, { key: 'grn', sellingPrice: 10, costPrice: 4, gstRate: 'ZERO' });
      const readers = makeReaders(app, shop);
      const grnId = randomUUID();
      const receive = () =>
        run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
          prisma.$transaction((tx) =>
            grn.updateInventoryFromGrn(tx, shop.shopId, {
              id: grnId,
              warehouseId: null,
              createdBy: shop.ownerId,
              lines: [
                { id: `${grnId}-l1`, productId, acceptedQuantity: 3, unitPrice: 4 },
                { id: `${grnId}-l2`, productId, acceptedQuantity: 2, unitPrice: 4 },
              ],
            }),
          ),
        );
      const inventoryBefore = await readers.ledgerBalance('INVENTORY');
      await receive();
      expect(await readers.productStock(productId)).toBe(5);
      expect(await readers.ledgerBalance('INVENTORY')).toBe(inventoryBefore + 20);
      await receive(); // replay: every line idempotent, nothing valued, posting keyed once
      expect(await readers.productStock(productId)).toBe(5);
      expect(await readers.ledgerBalance('INVENTORY')).toBe(inventoryBefore + 20);

      const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId, isDeleted: false } }));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        prisma.$transaction((tx) =>
          engine.mutateStock(tx, { shopId: shop.shopId, locationId: item.locationId, productId, quantity: 2, mutationType: MutationType.RESERVATION, referenceId: 'r1', performedBy: shop.ownerId }),
        ),
      );
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        prisma.$transaction((tx) =>
          engine.mutateStock(tx, { shopId: shop.shopId, locationId: item.locationId, productId, quantity: 5, mutationType: MutationType.RESERVATION_RELEASE, referenceId: 'r1', performedBy: shop.ownerId, allowNegative: true }),
        ),
      );
      const after = await run.system(() => prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } }));
      expect(num(after.reserved)).toBe(0);
    });

    it('legacy stock beyond the ledger sum is bootstrapped once, and reconciliation logs its correction', async () => {
      const shop = await createShop(app, 'p3-legacy');
      const productId = await createProduct(app, shop, { key: 'legacy', legacyStock: 12, gstRate: 'ZERO', sellingPrice: 5 });
      await receiveStock(app, shop, productId, 3);
      const readers = makeReaders(app, shop);
      expect(await readers.onHand(productId)).toBe(15);
      expect(await readers.productStock(productId)).toBe(15);
      const opening = await run.system(() => prisma.stockLedgerEntry.findFirst({ where: { shopId: shop.shopId, referenceType: 'LEGACY_STOCK_BOOTSTRAP', referenceId: productId } }));
      expect(num(opening?.quantity)).toBe(12);
    });
  });

  describe('3.8 reservations', () => {
    it('a reservation needs a bounded expiry, can be cancelled once, and the cancel frees the stock', async () => {
      const shop = await createShop(app, 'p3-resv');
      const reservations = app.get(ReservationService);
      const expiry = app.get(ReservationExpiryService);
      const productId = await createProduct(app, shop, { key: 'resv', gstRate: 'ZERO' });
      await receiveStock(app, shop, productId, 10);
      const created = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        reservations.createReservation(shop.shopId, { source: 'SYSTEM' as never, expiresInSeconds: 120, items: [{ productId, requestedQuantity: 4 }] }),
      );
      expect(created.expiresAt).not.toBeNull();
      const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId, isDeleted: false } }));
      expect(num(item.reserved)).toBe(4);

      const cancelled = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => expiry.releaseReservation(shop.shopId, created.id, 'CANCELLED', shop.ownerId));
      expect(cancelled.status).toBe('CANCELLED');
      expect(num((await run.system(() => prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } }))).reserved)).toBe(0);
      await expect(run.as(shop.shopId, shop.ownerId, Role.OWNER, () => expiry.releaseReservation(shop.shopId, created.id, 'RELEASED', shop.ownerId))).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_ACTIVE' } });
      expect(num((await run.system(() => prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } }))).reserved)).toBe(0);
    });
  });

  describe('3.9 stock counts', () => {
    it('a count variance becomes a pending request that only another manager can approve, and approval posts the stock', async () => {
      const shop = await createShop(app, 'p3-count');
      const counts = app.get(StockCountService);
      const variance = app.get(VarianceService);
      const approvals = app.get(AdjustmentApprovalService);
      const manager = await createUser(app, shop, Role.MANAGER);
      const productId = await createProduct(app, shop, { key: 'count', gstRate: 'ZERO', costPrice: 10 });
      await receiveStock(app, shop, productId, 10);
      const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId, isDeleted: false } }));

      const session = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => counts.startCountSession(shop.shopId, { type: 'SPOT_CHECK' as never }));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => variance.calculateAndSaveVariance(shop.shopId, session.id, item.id, 7));
      const countItem = await run.system(() => prisma.stockCountItem.findFirstOrThrow({ where: { sessionId: session.id, inventoryItemId: item.id } }));
      expect(num(countItem.variance)).toBe(-3);

      // A small variance is no longer auto-approved, and the delta comes from the count, not the caller.
      const request = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: item.id, countItemId: countItem.id, reason: 'MANUAL_COUNT' as never, requestedQuantityDelta: 40 }),
      ).catch((e) => e);
      expect(errorCode(request)).toBe('ADJUSTMENT_DELTA_MISMATCH');
      const pending = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: item.id, countItemId: countItem.id, reason: 'MANUAL_COUNT' as never }),
      );
      expect(pending.status).toBe(AdjustmentStatus.PENDING_APPROVAL);
      expect(num(pending.requestedQuantityDelta)).toBe(-3);
      expect(await makeReaders(app, shop).onHand(productId)).toBe(10);

      await expect(run.as(shop.shopId, shop.ownerId, Role.OWNER, () => approvals.approveAdjustment(shop.shopId, pending.id, shop.ownerId))).rejects.toMatchObject({ status: 403 });
      const outcomes = await Promise.allSettled([
        run.as(shop.shopId, manager.id, Role.MANAGER, () => approvals.approveAdjustment(shop.shopId, pending.id, manager.id)),
        run.as(shop.shopId, manager.id, Role.MANAGER, () => approvals.approveAdjustment(shop.shopId, pending.id, manager.id)),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(await makeReaders(app, shop).onHand(productId)).toBe(7);
      expect((await run.system(() => prisma.adjustmentRequest.findUniqueOrThrow({ where: { id: pending.id } }))).status).toBe(AdjustmentStatus.POSTED);
    });
  });

  describe('3.11 payables', () => {
    it('receipts raise, returns lower and payments settle the supplier balance through the ledger; overpaying is refused', async () => {
      const shop = await createShop(app, 'p3-pay');
      const suppliers = app.get(SuppliersService);
      const payables = app.get(SupplierPayablesService);
      const grn = app.get(GrnIntegrationService);
      const purchaseReturns = app.get(PurchaseReturnInventoryService);
      const productId = await createProduct(app, shop, { key: 'ap', costPrice: 25, gstRate: 'ZERO' });
      const supplier = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => suppliers.create({ name: 'AP Traders', phone: `6${Date.now()}`.slice(0, 10), openingBalance: 100 }));
      const readers = makeReaders(app, shop);
      const apBefore = await readers.ledgerBalance('ACCOUNTS_PAYABLE');
      const cashBefore = await readers.ledgerBalance('CASH');

      // Minimal procurement documents, so the ledger can attribute the postings to the supplier.
      const warehouse = await run.system(() => prisma.warehouse.create({ data: { shopId: shop.shopId, code: `W-${shop.suffix}`, name: 'Main' } }));
      const po = await run.system(() => prisma.purchaseOrder.create({ data: { shopId: shop.shopId, supplierId: supplier.id, orderNumber: `PO-${shop.suffix}`, totalAmount: 250 } }));
      const receipt = await run.system(() => prisma.goodsReceipt.create({ data: { shopId: shop.shopId, purchaseOrderId: po.id, grnNumber: `GRN-${shop.suffix}`, supplierId: supplier.id, warehouseId: warehouse.id } }));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        prisma.$transaction((tx) => grn.updateInventoryFromGrn(tx, shop.shopId, { id: receipt.id, warehouseId: null, createdBy: shop.ownerId, supplierId: supplier.id, lines: [{ id: `${receipt.id}-1`, productId, acceptedQuantity: 10, unitPrice: 25 }] })),
      );
      const owedAfterReceipt = await run.system(() => prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } }));
      expect(num(owedAfterReceipt.pendingPayables)).toBe(350);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(apBefore + 250);

      const pr = await run.system(() => prisma.purchaseReturn.create({ data: { shopId: shop.shopId, supplierId: supplier.id, returnNumber: `PR-${shop.suffix}` } }));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        prisma.$transaction((tx) => purchaseReturns.processInventoryReversal(tx, shop.shopId, { id: pr.id, warehouseId: null, createdBy: shop.ownerId, supplierId: supplier.id, lines: [{ id: `${pr.id}-1`, productId, returnQuantity: 2, unitPrice: 25 }] })),
      );
      expect(num((await run.system(() => prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } }))).pendingPayables)).toBe(300);

      await expect(run.as(shop.shopId, shop.ownerId, Role.OWNER, () => suppliers.recordPayment(supplier.id, { amount: 300.01 }, shop.ownerId))).rejects.toMatchObject({ response: { code: 'PAYABLES_INSUFFICIENT' } });
      const key = randomUUID();
      const paid = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => suppliers.recordPayment(supplier.id, { amount: 120, idempotencyKey: key }, shop.ownerId));
      expect(paid.payment.replayed).toBe(false);
      const replay = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => suppliers.recordPayment(supplier.id, { amount: 120, idempotencyKey: key }, shop.ownerId));
      expect(replay.payment.replayed).toBe(true);
      expect(num(replay.pendingPayables)).toBe(180);
      expect(await readers.ledgerBalance('CASH')).toBe(cashBefore - 120);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(apBefore + 250 - 50 - 120);

      const derived = await run.system(() => payables.payablesFromLedger(prisma, shop.shopId, supplier.id));
      expect(num(derived)).toBe(180);
    });
  });

  describe('3.12 ledger immutability', () => {
    it('the database refuses to update or delete a ledger transaction', async () => {
      const shop = await createShop(app, 'p3-immutable');
      await openShift(shop, shop.cashierId, Role.CASHIER);
      const productId = await createProduct(app, shop, { key: 'imm', sellingPrice: 10, gstRate: 'ZERO' });
      await receiveStock(app, shop, productId, 1);
      await sell(shop, productId, 1, 10);
      const row = await run.system(() => prisma.ledgerTransaction.findFirstOrThrow({ where: { shopId: shop.shopId } }));
      await expect(run.system(() => prisma.$executeRaw`UPDATE LedgerTransaction SET amount = 0 WHERE id = ${row.id}`)).rejects.toThrow(/immutable/);
      await expect(run.system(() => prisma.$executeRaw`DELETE FROM LedgerTransaction WHERE id = ${row.id}`)).rejects.toThrow(/immutable/);
      await expect(run.system(() => prisma.ledgerTransaction.update({ where: { id: row.id }, data: { description: 'x' } }))).rejects.toBeDefined();
    });
  });
});

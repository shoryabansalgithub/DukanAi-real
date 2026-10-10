/**
 * Roadmap phase 1 exit gate: two shops, every write route that accepts an
 * ID in its body, foreign IDs. Shop A's owner sends shop B's identifiers and
 * must get a 404 (the row does not exist for A) or 400, and nothing in A may
 * end up pointing at B. The last block exercises the Prisma tenant extension
 * directly: filters, updates and nested writes cannot cross shops either.
 */
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductVersioningService } from '../../src/product-versioning/product-versioning.service';
import { createUser, httpAs, ownerOf } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

describe('tenant isolation: foreign IDs on every write route', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let A: TestShop;
  let B: TestShop;
  let http: Awaited<ReturnType<typeof httpAs>>;
  // shop B rows the attacker knows the IDs of
  let b: {
    product: string;
    variant: string;
    item: string;
    supplier: string;
    warehouse: string;
    location: string;
    user: string;
    po: string;
    poItem: string;
    grn: string;
    grnLine: string;
    batch: string;
    customer: string;
    category: string;
  };
  // shop A rows the requests are made against
  let a: { product: string; supplier: string; warehouse: string; po: string; grn: string; batch: string; item: string };

  const rejected = (status: number) => expect([400, 404]).toContain(status);

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    A = await createShop(app, 'isoA');
    B = await createShop(app, 'isoB');
    http = (await httpAs(app, A, ownerOf(A)));

    const seed = async (shop: TestShop, tag: string) => {
      const product = await createProduct(app, shop, { key: `${tag}p` });
      await receiveStock(app, shop, product, 20);
      return run.system(async () => {
        const item = await prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId: product } });
        const location = await prisma.location.findUniqueOrThrow({ where: { id: item.locationId } });
        const supplier = await prisma.supplier.create({ data: { name: `${tag} supplier`, phone: `7${shop.suffix.replace(/\D/g, '').slice(-9).padStart(9, '2')}`, shopId: shop.shopId } });
        const po = await prisma.purchaseOrder.create({ data: { shopId: shop.shopId, supplierId: supplier.id, orderNumber: `PO-${tag}-${shop.suffix}`, totalAmount: 0 } });
        const poItem = await prisma.purchaseOrderItem.create({ data: { shopId: shop.shopId, purchaseOrderId: po.id, productId: product, quantity: 5, unitCost: 10, totalCost: 50 } });
        const grn = await prisma.goodsReceipt.create({ data: { shopId: shop.shopId, purchaseOrderId: po.id, supplierId: supplier.id, warehouseId: location.warehouseId, grnNumber: `GRN-${tag}-${shop.suffix}` } });
        const grnLine = await prisma.goodsReceiptLine.create({ data: { shopId: shop.shopId, goodsReceiptId: grn.id, productId: product, orderedQuantity: 5, receivedQuantity: 5, acceptedQuantity: 5 } });
        const batch = await prisma.batch.create({ data: { shopId: shop.shopId, productId: product, batchNumber: `B-${tag}-${shop.suffix}`, type: 'PURCHASE' } });
        const variant = await prisma.productVariant.create({ data: { shopId: shop.shopId, productId: product, sku: `${tag}-var-${shop.suffix}` } });
        const category = await prisma.category.create({ data: { shopId: shop.shopId, name: `${tag} cat ${shop.suffix}` } });
        return { product, variant: variant.id, item: item.id, supplier: supplier.id, warehouse: location.warehouseId, location: location.id, po: po.id, poItem: poItem.id, grn: grn.id, grnLine: grnLine.id, batch: batch.id, customer: shop.customerId, category: category.id };
      });
    };
    const seededB = await seed(B, 'b');
    b = { ...seededB, user: (await createUser(app, B, Role.MANAGER)).id };
    const seededA = await seed(A, 'a');
    a = { product: seededA.product, supplier: seededA.supplier, warehouse: seededA.warehouse, po: seededA.po, grn: seededA.grn, batch: seededA.batch, item: seededA.item };
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('purchasing', () => {
    const line = (productId: string, extra: Record<string, unknown> = {}) => ({ productId, quantity: 1, unitCost: 10, ...extra });

    it('purchase order: foreign supplier, product, variant, warehouse and bin are refused', async () => {
      rejected((await http.post('/api/purchases').send({ supplierId: b.supplier, items: [line(a.product)] })).status);
      rejected((await http.post('/api/purchases').send({ supplierId: a.supplier, items: [line(b.product)] })).status);
      rejected((await http.post('/api/purchases').send({ supplierId: a.supplier, items: [line(a.product, { variantId: b.variant })] })).status);
      rejected((await http.post('/api/purchases').send({ supplierId: a.supplier, items: [line(a.product, { warehouseId: b.warehouse })] })).status);
      rejected((await http.post('/api/purchases').send({ supplierId: a.supplier, items: [line(a.product, { binId: b.location })] })).status);
      expect(await run.system(() => prisma.purchaseOrder.count({ where: { shopId: A.shopId, supplierId: b.supplier } }))).toBe(0);
    });

    it('goods receipt: foreign purchase order, supplier, warehouse, product and receipt line are refused', async () => {
      const grnLine = { productId: a.product, orderedQuantity: 1 };
      rejected((await http.post('/api/grn').send({ purchaseOrderId: b.po, supplierId: a.supplier, warehouseId: a.warehouse, lines: [grnLine] })).status);
      rejected((await http.post('/api/grn').send({ purchaseOrderId: a.po, supplierId: b.supplier, warehouseId: a.warehouse, lines: [grnLine] })).status);
      rejected((await http.post('/api/grn').send({ purchaseOrderId: a.po, supplierId: a.supplier, warehouseId: b.warehouse, lines: [grnLine] })).status);
      rejected((await http.post('/api/grn').send({ purchaseOrderId: a.po, supplierId: a.supplier, warehouseId: a.warehouse, lines: [{ productId: b.product }] })).status);
      rejected((await http.post(`/api/grn/${a.grn}/receive`).send({ lines: [{ id: b.grnLine, receivedQuantity: 99 }] })).status);
      const foreignLine = await run.system(() => prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: b.grnLine } }));
      expect(num(foreignLine.receivedQuantity)).toBe(5);
      expect(await run.system(() => prisma.goodsReceipt.count({ where: { shopId: A.shopId, OR: [{ purchaseOrderId: b.po }, { supplierId: b.supplier }, { warehouseId: b.warehouse }] } }))).toBe(0);
    });

    it('purchase return: foreign supplier, receipt and receipt line are refused', async () => {
      const lines = [{ productId: a.product, returnQuantity: 1 }];
      rejected((await http.post('/api/purchase-returns').send({ supplierId: b.supplier, lines })).status);
      rejected((await http.post('/api/purchase-returns').send({ supplierId: a.supplier, goodsReceiptId: b.grn, lines })).status);
      rejected((await http.post('/api/purchase-returns').send({ supplierId: a.supplier, lines: [{ productId: a.product, returnQuantity: 1, grnLineId: b.grnLine }] })).status);
      expect(await run.system(() => prisma.purchaseReturn.count({ where: { shopId: A.shopId, OR: [{ supplierId: b.supplier }, { goodsReceiptId: b.grn }] } }))).toBe(0);
    });

    it('vendor bill: foreign supplier, purchase order line and receipt line are refused', async () => {
      const lines = [{ productId: a.product, billedQuantity: 1, unitPrice: 10 }];
      rejected((await http.post('/api/vendor-bills').send({ supplierId: b.supplier, lines })).status);
      rejected((await http.post('/api/vendor-bills').send({ supplierId: a.supplier, lines: [{ ...lines[0], purchaseOrderLineId: b.poItem }] })).status);
      rejected((await http.post('/api/vendor-bills').send({ supplierId: a.supplier, lines: [{ ...lines[0], grnLineId: b.grnLine }] })).status);
      expect(await run.system(() => prisma.vendorBill.count({ where: { shopId: A.shopId, supplierId: b.supplier } }))).toBe(0);
    });

    it('supplier credit note: foreign supplier and product are refused', async () => {
      rejected((await http.post('/api/supplier-credit-notes').send({ supplierId: b.supplier, lines: [{ totalAmount: 1 }] })).status);
      rejected((await http.post('/api/supplier-credit-notes').send({ supplierId: a.supplier, lines: [{ productId: b.product, totalAmount: 1 }] })).status);
      expect(await run.system(() => prisma.supplierCreditNote.count({ where: { shopId: A.shopId, supplierId: b.supplier } }))).toBe(0);
    });

    it('workflows: a delegate or approver must be a user of the shop', async () => {
      rejected((await http.post('/api/procurement-workflows/delegations').send({ delegateUserId: b.user, startDate: '2030-01-01', endDate: '2030-02-01' })).status);
      rejected((await http.post('/api/procurement-workflows/definitions').send({ name: 'x', documentType: 'PURCHASE_ORDER', steps: [{ name: 's', approverId: b.user }] })).status);
      expect(await run.system(() => prisma.workflowDelegation.count({ where: { shopId: A.shopId, delegateUserId: b.user } }))).toBe(0);
    });
  });

  describe('stock', () => {
    it('batches: foreign product, batch and inventory item are refused', async () => {
      rejected((await http.post('/api/batches').send({ productId: b.product, batchNumber: `X-${A.suffix}`, type: 'PURCHASE' })).status);
      rejected((await http.post(`/api/batches/${b.batch}/stock`).send({ inventoryItemId: a.item, quantity: 1 })).status);
      rejected((await http.post(`/api/batches/${a.batch}/stock`).send({ inventoryItemId: b.item, quantity: 1 })).status);
      expect(await run.system(() => prisma.batchStock.count({ where: { OR: [{ batchId: b.batch, inventoryItemId: a.item }, { batchId: a.batch, inventoryItemId: b.item }] } }))).toBe(0);
    });

    it('reservations, stock counts and inventory items refuse foreign products, items, warehouses and users', async () => {
      rejected((await http.post('/api/reservations').send({ source: 'POS', items: [{ productId: b.product, requestedQuantity: 1 }] })).status);
      rejected((await http.post('/api/stock-counts/sessions').send({ type: 'FULL', warehouseId: b.warehouse })).status);
      rejected((await http.post('/api/stock-counts/sessions').send({ type: 'FULL', assignedToUserId: b.user })).status);
      rejected((await http.post('/api/stock-counts/adjustments').send({ inventoryItemId: b.item, reason: 'CORRECTION', requestedQuantityDelta: 1 })).status);
      rejected((await http.post('/api/inventory-domain').send({ productId: b.product })).status);
      rejected((await http.post('/api/warehouse-domain/locations').send({ warehouseId: b.warehouse, code: `L-${A.suffix}`, name: 'Bin', type: 'BIN' })).status);
      expect(await run.system(() => prisma.reservationItem.count({ where: { shopId: A.shopId, productId: b.product } }))).toBe(0);
      expect(await run.system(() => prisma.stockCountSession.count({ where: { shopId: A.shopId, OR: [{ warehouseId: b.warehouse }, { assignedToUserId: b.user }] } }))).toBe(0);
      expect(await run.system(() => prisma.inventoryItem.count({ where: { shopId: A.shopId, productId: b.product } }))).toBe(0);
    });
  });

  describe('documents', () => {
    it('revision compare refuses a foreign revision; the duplicate invoice and return stacks are gone (roadmap 4.5)', async () => {
      const versioning = app.get(ProductVersioningService);
      const revA = await run.as(A.shopId, A.ownerId, Role.OWNER, () => versioning.createDraft(a.product));
      const revB = await run.as(B.shopId, B.ownerId, Role.OWNER, () => versioning.createDraft(b.product));
      expect((await http.get(`/api/products/${a.product}/revisions/compare/${revA.id}/${revB.id}`)).status).toBe(404);
      // POS billing (`/billing/*`) is the only invoice, return and payment path; these routes no longer exist.
      expect((await http.post('/api/returns/initiate').send({ returnLines: [{ productId: b.product, quantity: 1 }] })).status).toBe(404);
      expect((await http.post('/api/invoices/generate').send({ customerId: b.customer, lines: [] })).status).toBe(404);
      expect((await http.post('/api/payments/capture').send({ invoiceId: 'x', amount: 1 })).status).toBe(404);
    });
  });

  describe('Prisma tenant extension', () => {
    const asA = <T>(fn: () => Promise<T>) => run.as(A.shopId, A.ownerId, Role.OWNER, fn);

    it('reads never see the other shop, even by primary key', async () => {
      expect(await asA(() => prisma.product.findUnique({ where: { id: b.product } }))).toBeNull();
      expect(await asA(() => prisma.supplier.count({ where: { id: b.supplier } }))).toBe(0);
      await expect(asA(() => prisma.product.findMany({ where: { shopId: B.shopId } }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a row cannot be moved to another shop', async () => {
      await expect(asA(() => prisma.product.update({ where: { id: a.product }, data: { shopId: B.shopId } }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(asA(() => prisma.product.create({ data: { name: 'x', sku: `x-${A.suffix}`, shopId: B.shopId } as never }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('nested writes cannot link rows of another shop', async () => {
      await expect(asA(() => prisma.product.update({ where: { id: a.product }, data: { category: { connect: { id: b.category } } } }))).rejects.toMatchObject({ code: 'P2025' });
      const product = await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: a.product } }));
      expect(product.categoryId).toBeNull();
    });
  });
  describe('TenantGuard (roadmap 1.8)', () => {
    it('only an ACTIVE shop can use the API', async () => {
      const bOwner = (await httpAs(app, B, ownerOf(B)));
      expect((await bOwner.get('/api/shops/me')).status).toBe(200);
      try {
        for (const status of ['SUSPENDED', 'LOCKED', 'ARCHIVED'] as const) {
          await run.system(() => prisma.shop.update({ where: { id: B.shopId }, data: { status } }));
          const res = await bOwner.get('/api/shops/me');
          expect({ status, code: res.status }).toEqual({ status, code: 403 });
        }
      } finally {
        await run.system(() => prisma.shop.update({ where: { id: B.shopId }, data: { status: 'ACTIVE' } }));
      }
      expect((await bOwner.get('/api/shops/me')).status).toBe(200);
    });
  });
});

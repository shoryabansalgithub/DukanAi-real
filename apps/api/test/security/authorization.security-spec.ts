/**
 * Authorization and shop isolation (audit P0-1, P0-2, P0-3).
 *
 * Each test states the behaviour a secure API must show. Findings that are
 * still open use `it.failing`; see README.md for the flip convention.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProductVersioningService } from '../../src/product-versioning/product-versioning.service';
import { bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from '../integration/pos-fixtures';
import { createUser, httpAs, ownerOf } from './security-fixtures';

describe('security: authorization and shop isolation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let shopA: TestShop;
  let shopB: TestShop;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    shopA = await createShop(app, 'secA');
    shopB = await createShop(app, 'secB');
  });

  afterAll(async () => {
    await app?.close();
  });

  const inventoryItemOf = async (shop: TestShop, productId: string) =>
    run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId, isDeleted: false } }));

  describe('P0-1: PATCH /shops/me accepts only the documented profile fields', () => {
    it('a MANAGER cannot change roles through the shop profile body', async () => {
      const manager = await createUser(app, shopA, Role.MANAGER);
      const res = await (await httpAs(app, shopA, manager))
        .patch('/api/shops/me')
        .send({ name: `Renamed ${shopA.suffix}`, users: { updateMany: { where: { id: manager.id }, data: { role: 'OWNER' } } } });

      expect(res.status).toBe(400); // unknown properties are rejected, not forwarded to Prisma
      const after = await run.system(() => prisma.user.findUniqueOrThrow({ where: { id: manager.id } }));
      expect(after.role).toBe(Role.MANAGER);
    });

    it('the shop profile body cannot connect another shop\'s product', async () => {
      const foreignProduct = await createProduct(app, shopB, { key: 'foreign' });
      const res = await (await httpAs(app, shopA, ownerOf(shopA)))
        .patch('/api/shops/me')
        .send({ products: { connect: [{ id: foreignProduct }] } });

      expect(res.status).toBe(400);
      const product = await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: foreignProduct } }));
      expect(product.shopId).toBe(shopB.shopId);
    });
  });

  describe('P0-2: write routes require an explicit role', () => {
    it('control: a VIEWER is refused on POST /products', async () => {
      const viewer = await createUser(app, shopA, Role.VIEWER);
      const res = await (await httpAs(app, shopA, viewer)).post('/api/products').send({ name: 'x', sellingPrice: 1 });
      expect(res.status).toBe(403);
    });

    it('a VIEWER cannot adjust stock', async () => {
      const viewer = await createUser(app, shopA, Role.VIEWER);
      const productId = await createProduct(app, shopA, { key: 'adjust' });
      await receiveStock(app, shopA, productId, 10);
      const item = await inventoryItemOf(shopA, productId);

      const res = await (await httpAs(app, shopA, viewer)).post(`/api/inventory-domain/${item.id}/adjust`).send({ reason: 'CORRECTION', quantityChange: 100000 });

      expect(res.status).toBe(403);
      expect(await makeReaders(app, shopA).onHand(productId)).toBe(10);
    });

    it('a VIEWER cannot lock stock in a reservation', async () => {
      const viewer = await createUser(app, shopA, Role.VIEWER);
      const productId = await createProduct(app, shopA, { key: 'reserve' });
      await receiveStock(app, shopA, productId, 50);

      const res = await (await httpAs(app, shopA, viewer)).post('/api/reservations').send({ source: 'POS', items: [{ productId, requestedQuantity: 50 }] });

      expect(res.status).toBe(403);
      const reservations = await run.system(() => prisma.reservationItem.count({ where: { productId } }));
      expect(reservations).toBe(0);
    });
  });

  describe('P0-3: records of another shop are unreachable by ID', () => {
    it('control: another shop\'s product is 404 on the product route', async () => {
      const foreignProduct = await createProduct(app, shopB, { key: 'ctrl' });
      const res = await (await httpAs(app, shopA, ownerOf(shopA))).get(`/api/products/${foreignProduct}`);
      expect(res.status).toBe(404);
    });

    it('batch stock of another shop cannot be changed', async () => {
      const productB = await createProduct(app, shopB, { key: 'batch' });
      await receiveStock(app, shopB, productB, 20);
      const itemB = await inventoryItemOf(shopB, productB);
      const batchB = await run.system(() => prisma.batch.create({ data: { shopId: shopB.shopId, productId: productB, batchNumber: `B-${shopB.suffix}`, type: 'PURCHASE' } }));
      await run.system(() => prisma.batchStock.create({ data: { shopId: shopB.shopId, batchId: batchB.id, inventoryItemId: itemB.id, quantity: 20 } }));

      const res = await (await httpAs(app, shopA, ownerOf(shopA))).post(`/api/batches/${batchB.id}/stock`).send({ inventoryItemId: itemB.id, quantity: -15 });

      expect(res.status).toBe(404);
      const stock = await run.system(() => prisma.batchStock.findUniqueOrThrow({ where: { shopId_batchId_inventoryItemId: { shopId: shopB.shopId, batchId: batchB.id, inventoryItemId: itemB.id } } }));
      expect(num(stock.quantity)).toBe(20);
    });

    it('a vendor bill cannot reference another shop\'s supplier', async () => {
      const supplierB = await run.system(() => prisma.supplier.create({ data: { name: 'Foreign supplier', phone: `8${shopB.suffix.replace(/\D/g, '').slice(-9).padStart(9, '1')}`, shopId: shopB.shopId } }));
      const productA = await createProduct(app, shopA, { key: 'vb' });
      const client = (await httpAs(app, shopA, ownerOf(shopA)));

      const res = await client.post('/api/vendor-bills').send({ supplierId: supplierB.id, lines: [{ productId: productA, billedQuantity: 1, unitPrice: 10, taxPercentage: 0 }] });

      expect([400, 403, 404]).toContain(res.status);
      const leaked = await run.system(() => prisma.vendorBill.count({ where: { shopId: shopA.shopId, supplierId: supplierB.id } }));
      expect(leaked).toBe(0);
      const list = await client.get('/api/vendor-bills');
      expect(list.status).toBe(200);
      expect((list.body as Array<{ supplierId: string }>).some((bill) => bill.supplierId === supplierB.id)).toBe(false);
    });

    it('revisions of another shop cannot be read through compare', async () => {
      const versioning = app.get(ProductVersioningService);
      const productA = await createProduct(app, shopA, { key: 'revA' });
      const productB = await createProduct(app, shopB, { key: 'revB' });
      const revA = await run.as(shopA.shopId, shopA.ownerId, Role.OWNER, () => versioning.createDraft(productA));
      const revB = await run.as(shopB.shopId, shopB.ownerId, Role.OWNER, () => versioning.createDraft(productB));

      const res = await (await httpAs(app, shopA, ownerOf(shopA))).get(`/api/products/${productA}/revisions/compare/${revA.id}/${revB.id}`);

      expect(res.status).toBe(404);
    });
  });
});

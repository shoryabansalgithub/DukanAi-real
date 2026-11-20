/**
 * Roadmap 4.2 + 4.3: the purchasing workflow end to end over HTTP, against
 * the real database. One shop, an OWNER who raises documents, two MANAGERs
 * who approve them, a CASHIER who may not. Every figure is read back from
 * the tables (stock, ledger balances, payables), never from a response alone.
 *
 *   warehouse + locations (4.3) → purchase order → approval (separation of
 *   duties) → goods receipts against the order lines (Σ accepted ≤ ordered,
 *   prices from the order, inspection applied) → vendor bill (three-way
 *   match, cumulative billing) → payments → purchase return (over-return
 *   refused, the return's own rows excluded) → supplier credit note
 *   (allocation to the bill) → outbox relay hands the rows to the worker.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isPurchaseRelayType } from '../../src/common/outbox/outbox-routing';
import { PurchaseOutboxRelayCron } from '../../src/purchase-events-domain/workers/purchase-outbox-relay.cron';
import { createUser, httpAs, ownerOf, cashierOf, TestUser } from '../security/security-fixtures';
import { bootApp, createProduct, createShop, makeReaders, num, tenantRunner, TestShop } from './pos-fixtures';

type Http = Awaited<ReturnType<typeof httpAs>>;

describe('procurement workflow (roadmap 4.2 / 4.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let shop: TestShop;
  let other: TestShop;
  let owner: Http;
  let manager: Http;
  let manager2: Http;
  let cashier: Http;
  let managerUser: TestUser;
  let readers: ReturnType<typeof makeReaders>;

  let p1: string;
  let p2: string;
  let supplierId: string;
  let otherSupplierId: string;
  let warehouseId: string;
  let zoneId: string;

  let poId: string;
  let poItem1: string;
  let poItem2: string;
  let grn1: { id: string; line1: string; line2: string };
  let grn2Id: string;
  let billId: string;
  let returnId: string;
  let creditId: string;

  const stockOf = async (productId: string) => {
    const agg = await run.system(() => prisma.inventoryItem.aggregate({ where: { shopId: shop.shopId, productId, isDeleted: false }, _sum: { onHand: true } }));
    return num(agg._sum.onHand);
  };
  const payables = async () => num((await run.system(() => prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }))).pendingPayables);
  const code = (res: { body: { code?: string; error?: { code?: string } } }) => res.body.code ?? res.body.error?.code;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    shop = await createShop(app, 'proc');
    other = await createShop(app, 'procB');
    readers = makeReaders(app, shop);
    managerUser = await createUser(app, shop, Role.MANAGER);
    const manager2User = await createUser(app, shop, Role.MANAGER);
    owner = await httpAs(app, shop, ownerOf(shop));
    manager = await httpAs(app, shop, managerUser);
    manager2 = await httpAs(app, shop, manager2User);
    cashier = await httpAs(app, shop, cashierOf(shop));

    p1 = await createProduct(app, shop, { key: 'proc1', costPrice: 50 });
    p2 = await createProduct(app, shop, { key: 'proc2', costPrice: 25 });
    const phone = (n: number) => `8${shop.suffix.replace(/\D/g, '').slice(-8).padStart(8, '3')}${n}`;
    [supplierId, otherSupplierId] = await run.system(async () => [
      (await prisma.supplier.create({ data: { name: `Acme ${shop.suffix}`, phone: phone(1), shopId: shop.shopId } })).id,
      (await prisma.supplier.create({ data: { name: `Other ${shop.suffix}`, phone: phone(2), shopId: shop.shopId } })).id,
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('4.3 warehouses and locations', () => {
    it('a manager creates a warehouse; the code is unique per shop; a cashier may not', async () => {
      const created = await owner.post('/api/warehouse-domain/warehouses').send({ code: `WH-${shop.suffix}`, name: 'Main', type: 'MAIN', city: 'Bengaluru' });
      expect(created.status).toBe(201);
      expect(created.body.shopId).toBe(shop.shopId);
      warehouseId = created.body.id;

      const duplicate = await owner.post('/api/warehouse-domain/warehouses').send({ code: `WH-${shop.suffix}`, name: 'Again', type: 'RETAIL_STORE' });
      expect(duplicate.status).toBe(409);
      expect(code(duplicate)).toBe('WAREHOUSE_CODE_IN_USE');

      expect((await cashier.post('/api/warehouse-domain/warehouses').send({ code: `WH2-${shop.suffix}`, name: 'No', type: 'MAIN' })).status).toBe(403);
      expect((await owner.post('/api/warehouse-domain/warehouses').send({ code: `WH3-${shop.suffix}`, name: 'Bad', type: 'GARAGE' })).status).toBe(400);
      expect(await run.system(() => prisma.warehouse.count({ where: { shopId: shop.shopId, code: { startsWith: 'WH' } } }))).toBe(1);
    });

    it('concurrent creates of one code yield exactly one warehouse (the unique index is the guard, not the pre-check)', async () => {
      const code = `RACE-${shop.suffix}`;
      const results = await Promise.all(Array.from({ length: 6 }, () => owner.post('/api/warehouse-domain/warehouses').send({ code, name: 'Race', type: 'DARK_STORE' })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      expect(await run.system(() => prisma.warehouse.count({ where: { shopId: shop.shopId, code } }))).toBe(1);
      // The same code in another shop is a different warehouse.
      const theirs = await run.system(() => prisma.warehouse.create({ data: { shopId: other.shopId, code, name: 'Theirs too', type: 'MAIN' } }));
      expect(theirs.code).toBe(code);
    });

    it('locations hang off a warehouse of the shop with a materialised path; codes are unique per warehouse', async () => {
      const zone = await owner.post('/api/warehouse-domain/locations').send({ warehouseId, type: 'ZONE', code: 'Z1' });
      expect(zone.status).toBe(201);
      expect(zone.body.path).toBe(`/${warehouseId}/Z1`);
      expect(zone.body.depth).toBe(0);
      zoneId = zone.body.id;

      const rack = await owner.post('/api/warehouse-domain/locations').send({ warehouseId, parentId: zoneId, type: 'RACK', code: 'R1' });
      expect(rack.status).toBe(201);
      expect(rack.body.path).toBe(`/${warehouseId}/Z1/R1`);
      expect(rack.body.depth).toBe(1);

      const duplicate = await owner.post('/api/warehouse-domain/locations').send({ warehouseId, type: 'ZONE', code: 'Z1' });
      expect(duplicate.status).toBe(409);
      expect(code(duplicate)).toBe('LOCATION_CODE_IN_USE');

      // A parent must belong to the same warehouse; a warehouse of another shop does not exist for this one.
      const foreignWarehouse = await run.system(() => prisma.warehouse.create({ data: { shopId: other.shopId, code: `WH-${other.suffix}`, name: 'Theirs', type: 'MAIN' } }));
      expect((await owner.post('/api/warehouse-domain/locations').send({ warehouseId: foreignWarehouse.id, type: 'ZONE', code: 'Z9' })).status).toBe(404);
      expect((await owner.post('/api/warehouse-domain/locations').send({ warehouseId: foreignWarehouse.id, parentId: zoneId, type: 'RACK', code: 'R9' })).status).toBe(404);
      expect((await cashier.post('/api/warehouse-domain/locations').send({ warehouseId, type: 'ZONE', code: 'Z2' })).status).toBe(403);

      const subtree = await owner.get(`/api/warehouse-domain/warehouses/${warehouseId}/locations/subtree?path=/${warehouseId}/Z1`);
      expect(subtree.status).toBe(200);
      expect(subtree.body.map((l: { code: string }) => l.code)).toEqual(['Z1', 'R1']);
      expect(await run.system(() => prisma.location.count({ where: { warehouseId: foreignWarehouse.id } }))).toBe(0);
    });
  });

  describe('purchase order', () => {
    it('is numbered from the shop sequence, totalled from its lines and opened as DRAFT', async () => {
      expect((await cashier.post('/api/purchases').send({ supplierId, items: [{ productId: p1, quantity: 1, unitCost: 1 }] })).status).toBe(403);

      const created = await owner.post('/api/purchases').send({
        supplierId,
        totalAmount: 1, // ignored: the server computes the total
        items: [
          { productId: p1, quantity: 10, unitCost: 50 },
          { productId: p2, quantity: 4, unitCost: 25 },
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.orderNumber).toMatch(/^PO-\d{6}-\d{5}$/);
      expect(created.body.status).toBe('DRAFT');
      expect(num(created.body.totalAmount)).toBe(600);
      poId = created.body.id;
      poItem1 = created.body.items.find((i: { productId: string }) => i.productId === p1).id;
      poItem2 = created.body.items.find((i: { productId: string }) => i.productId === p2).id;

      const second = await owner.post('/api/purchases').send({ supplierId, items: [{ productId: p1, quantity: 1, unitCost: 1 }] });
      expect(Number(second.body.orderNumber.slice(-5))).toBe(Number(created.body.orderNumber.slice(-5)) + 1);

      const fetched = await owner.get(`/api/purchases/${poId}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.timelines.map((t: { status: string }) => t.status)).toEqual(['DRAFT']);
    });

    it('cannot receive goods before it is approved', async () => {
      const res = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 1 }] });
      expect(res.status).toBe(400);
      expect(code(res)).toBe('PURCHASE_ORDER_NOT_RECEIVABLE');
    });

    it('submit opens one approval step; the submitter cannot approve; another manager can, once', async () => {
      const submitted = await owner.post(`/api/purchases/${poId}/submit`).send({});
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('SUBMITTED');
      expect(await run.system(() => prisma.purchaseOrderApproval.count({ where: { purchaseOrderId: poId, status: 'PENDING' } }))).toBe(1);

      expect((await owner.post(`/api/purchases/${poId}/submit`).send({})).status).toBe(400);

      const self = await owner.post(`/api/purchases/${poId}/approve`).send({ comments: 'mine' });
      expect(self.status).toBe(403);
      expect(code(self)).toBe('SEPARATION_OF_DUTIES');

      const approved = await manager.post(`/api/purchases/${poId}/approve`).send({ comments: 'ok' });
      expect(approved.status).toBe(201);
      expect(approved.body.status).toBe('APPROVED');

      const again = await manager2.post(`/api/purchases/${poId}/approve`).send({});
      expect(again.status).toBe(400);
      expect(code(again)).toBe('PURCHASE_ORDER_NOT_PENDING');

      const po = await run.system(() => prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { timelines: { orderBy: { createdAt: 'asc' } }, approvals: true } }));
      expect(po.timelines.map((t) => t.status)).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
      expect(po.approvals.map((a) => a.status)).toEqual(['APPROVED']);
      expect(po.approvals[0].approverId).toBe(managerUser.id);
    });
  });

  describe('goods receipts against the order lines', () => {
    it('refuses another supplier, a product that is not on the order and more than was ordered', async () => {
      const mismatch = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId: otherSupplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 1 }] });
      expect(mismatch.status).toBe(400);
      expect(code(mismatch)).toBe('GRN_SUPPLIER_MISMATCH');

      const stranger = await createProduct(app, shop, { key: 'proc3' });
      const notOnOrder = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: stranger, receivedQuantity: 1 }] });
      expect(notOnOrder.status).toBe(400);
      expect(code(notOnOrder)).toBe('GRN_LINE_NOT_ON_ORDER');

      const over = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 11 }] });
      expect(over.status).toBe(400);
      expect(code(over)).toBe('GRN_OVER_RECEIPT');

      const twice = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 1 }, { purchaseOrderItemId: poItem1, productId: p1, receivedQuantity: 1 }] });
      expect(twice.status).toBe(400);
      expect(code(twice)).toBe('GRN_LINE_DUPLICATE');
      expect(await run.system(() => prisma.goodsReceipt.count({ where: { purchaseOrderId: poId } }))).toBe(0);
    });

    it('takes ordered quantity and price from the order line, never from the client', async () => {
      const created = await owner.post('/api/grn').send({
        purchaseOrderId: poId,
        supplierId,
        warehouseId,
        lines: [
          { productId: p1, receivedQuantity: 6, unitPrice: 1, orderedQuantity: 99 } as Record<string, unknown>,
          { purchaseOrderItemId: poItem2, productId: p2, receivedQuantity: 4 },
        ],
      });
      // unitPrice / orderedQuantity are not part of the DTO: the whitelist refuses them.
      expect(created.status).toBe(400);

      const ok = await owner.post('/api/grn').send({
        purchaseOrderId: poId,
        supplierId,
        warehouseId,
        lines: [
          { productId: p1, receivedQuantity: 6 },
          { purchaseOrderItemId: poItem2, productId: p2, receivedQuantity: 4 },
        ],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.grnNumber).toMatch(/^GRN-\d{4}-\d{2}-\d{6}$/);
      expect(ok.body.status).toBe('DRAFT');
      const line1 = ok.body.lines.find((l: { productId: string }) => l.productId === p1);
      const line2 = ok.body.lines.find((l: { productId: string }) => l.productId === p2);
      expect(line1.purchaseOrderItemId).toBe(poItem1);
      expect(line2.purchaseOrderItemId).toBe(poItem2);
      expect(num(line1.orderedQuantity)).toBe(10);
      expect(num(line1.unitPrice)).toBe(50);
      expect(num(line2.unitPrice)).toBe(25);
      grn1 = { id: ok.body.id, line1: line1.id, line2: line2.id };
    });

    it('receiving is capped at the outstanding order quantity and stamps the received date', async () => {
      const over = await owner.post(`/api/grn/${grn1.id}/receive`).send({ lines: [{ id: grn1.line1, receivedQuantity: 11 }] });
      expect(over.status).toBe(400);
      expect(code(over)).toBe('GRN_OVER_RECEIPT');

      const received = await owner.post(`/api/grn/${grn1.id}/receive`).send({ lines: [{ id: grn1.line1, receivedQuantity: 6 }, { id: grn1.line2, receivedQuantity: 4 }] });
      expect(received.status).toBe(201);
      expect(received.body.status).toBe('RECEIVING');
      expect(received.body.receivedDate).toBeTruthy();
    });

    it('an inspection decides what is accepted, per line', async () => {
      const tooMany = await owner.post(`/api/grn/${grn1.id}/inspect`).send({ status: 'PASS', lines: [{ id: grn1.line1, acceptedQuantity: 6, rejectedQuantity: 1 }] });
      expect(tooMany.status).toBe(400);
      expect(code(tooMany)).toBe('GRN_INSPECTION_EXCEEDS_RECEIVED');

      const inspected = await owner.post(`/api/grn/${grn1.id}/inspect`).send({ status: 'PASS', lines: [{ id: grn1.line1, acceptedQuantity: 5, rejectedQuantity: 1 }, { id: grn1.line2, acceptedQuantity: 4 }] });
      expect(inspected.status).toBe(201);
      const lines = await run.system(() => prisma.goodsReceiptLine.findMany({ where: { goodsReceiptId: grn1.id } }));
      const l1 = lines.find((l) => l.id === grn1.line1)!;
      expect(num(l1.acceptedQuantity)).toBe(5);
      expect(num(l1.rejectedQuantity)).toBe(1);
      expect(num(l1.pendingQuantity)).toBe(5);
    });

    it('acceptance moves the inspected quantities into stock, posts the ledger and leaves the order PARTIALLY_RECEIVED', async () => {
      const before = await readers.ledgerBalance('INVENTORY');
      const accepted = await owner.post(`/api/grn/${grn1.id}/accept`).send({});
      expect(accepted.status).toBe(201);
      expect(accepted.body.status).toBe('ACCEPTED');
      expect(accepted.body.orderStatus).toBe('PARTIALLY_RECEIVED');

      expect(await stockOf(p1)).toBe(5);
      expect(await stockOf(p2)).toBe(4);
      // 5 × 50 + 4 × 25 = 350 received into stock, owed to the supplier.
      expect((await readers.ledgerBalance('INVENTORY')) - before).toBe(350);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(350);
      expect(await payables()).toBe(350);
      const grn = await run.system(() => prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grn1.id } }));
      expect(num(grn.totalQuantity)).toBe(9);
      expect(num(grn.totalValue)).toBe(350);
      // The stock landed in the receipt's warehouse, not the sale location.
      const items = await run.system(() => prisma.inventoryItem.findMany({ where: { shopId: shop.shopId, productId: p1 }, include: { location: true } }));
      expect(items.every((i) => i.location.warehouseId === warehouseId)).toBe(true);
      expect((await owner.get(`/api/purchases/${poId}`)).body.status).toBe('PARTIALLY_RECEIVED');

      // Accepting again is not a transition the receipt allows.
      expect((await owner.post(`/api/grn/${grn1.id}/accept`).send({})).status).toBe(400);
      expect(await stockOf(p1)).toBe(5);
    });

    it('the receiver cannot complete the receipt; another manager does', async () => {
      const self = await owner.post(`/api/grn/${grn1.id}/approve`).send({});
      expect(self.status).toBe(403);
      expect(code(self)).toBe('SEPARATION_OF_DUTIES');
      const done = await manager2.post(`/api/grn/${grn1.id}/approve`).send({ comments: 'checked' });
      expect(done.status).toBe(201);
      expect(done.body.status).toBe('COMPLETED');
    });

    it('a second receipt may only cover what is still outstanding, and completes the order', async () => {
      const over = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 6 }] });
      expect(over.status).toBe(400);
      expect(code(over)).toBe('GRN_OVER_RECEIPT');
      expect(over.body.details ?? over.body.error?.details).toMatchObject({ acceptedElsewhere: '5' });

      const created = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 5 }] });
      expect(created.status).toBe(201);
      grn2Id = created.body.id;
      expect(num(created.body.lines[0].orderedQuantity)).toBe(5);
      await owner.post(`/api/grn/${grn2Id}/receive`).send({ lines: [{ id: created.body.lines[0].id, receivedQuantity: 5 }] });

      // Without an inspection everything received is accepted.
      const accepted = await owner.post(`/api/grn/${grn2Id}/accept`).send({});
      expect(accepted.status).toBe(201);
      expect(accepted.body.orderStatus).toBe('RECEIVED');
      expect(await stockOf(p1)).toBe(10);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(600);
      expect(await payables()).toBe(600);

      const closed = await owner.post('/api/grn').send({ purchaseOrderId: poId, supplierId, warehouseId, lines: [{ productId: p1, receivedQuantity: 1 }] });
      expect(closed.status).toBe(400);
      expect(code(closed)).toBe('PURCHASE_ORDER_NOT_RECEIVABLE');
    });
  });

  describe('vendor bill', () => {
    it('is matched three ways on submit, cumulatively over the live bills of a receipt line', async () => {
      const lines = [
        { productId: p1, purchaseOrderLineId: poItem1, grnLineId: grn1.line1, billedQuantity: 5, unitPrice: 50 },
        { productId: p2, purchaseOrderLineId: poItem2, grnLineId: grn1.line2, billedQuantity: 4, unitPrice: 25 },
      ];
      const created = await owner.post('/api/vendor-bills').send({ supplierId, purchaseOrderId: poId, goodsReceiptId: grn1.id, lines });
      expect(created.status).toBe(201);
      expect(created.body.billNumber).toMatch(/^VB-\d{4}-\d{2}-\d{6}$/);
      expect(num(created.body.totalAmount)).toBe(350);
      expect(num(created.body.outstandingAmount)).toBe(350);
      billId = created.body.id;

      // 6 billed against 5 accepted (5 % tolerance) is refused at submission.
      const overBilled = await owner.post('/api/vendor-bills').send({ supplierId, lines: [{ ...lines[0], billedQuantity: 6 }] });
      expect(overBilled.status).toBe(201);
      expect((await owner.post(`/api/vendor-bills/${overBilled.body.id}/submit`).send({})).status).toBe(400);

      const submitted = await owner.post(`/api/vendor-bills/${billId}/submit`).send({});
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');

      // The first bill now counts: even one more unit on the same receipt line is over-billed.
      const oneMore = await owner.post('/api/vendor-bills').send({ supplierId, lines: [{ ...lines[0], billedQuantity: 1 }] });
      expect((await owner.post(`/api/vendor-bills/${oneMore.body.id}/submit`).send({})).status).toBe(400);
    });

    it('is approved by someone else, posted and paid in instalments through the payables authority', async () => {
      const self = await owner.post(`/api/vendor-bills/${billId}/approve`).send({});
      expect(self.status).toBe(403);
      const approved = await manager.post(`/api/vendor-bills/${billId}/approve`).send({});
      expect(approved.body.status).toBe('APPROVED');

      expect((await owner.post(`/api/vendor-bills/${billId}/pay`).send({ paymentAmount: 10 })).status).toBe(400);
      expect((await owner.post(`/api/vendor-bills/${billId}/post`).send({})).body.status).toBe('POSTED');

      const first = await owner.post(`/api/vendor-bills/${billId}/pay`).send({ paymentAmount: 200, tender: 'CASH', idempotencyKey: `pay-1-${shop.suffix}` });
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('PARTIALLY_PAID');
      expect(num(first.body.outstandingAmount)).toBe(150);
      expect(await payables()).toBe(400);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(400);

      // A replayed payment is not a second payment.
      const replay = await owner.post(`/api/vendor-bills/${billId}/pay`).send({ paymentAmount: 200, tender: 'CASH', idempotencyKey: `pay-1-${shop.suffix}` });
      expect(replay.status).toBe(201);
      expect(await payables()).toBe(400);
      expect(await run.system(() => prisma.supplierPayment.count({ where: { vendorBillId: billId } }))).toBe(1);
    });
  });

  describe('purchase return', () => {
    it('refuses unlinked lines and more than the receipt line accepted, counting other live returns', async () => {
      const unlinked = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: grn1.id, warehouseId, lines: [{ productId: p2, returnQuantity: 1 }] });
      expect(unlinked.status).toBe(400);
      expect(code(unlinked)).toBe('PURCHASE_RETURN_LINE_UNLINKED');

      const over = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: grn1.id, warehouseId, lines: [{ productId: p2, grnLineId: grn1.line2, returnQuantity: 5 }] });
      expect(over.status).toBe(400);
      expect(code(over)).toBe('PURCHASE_RETURN_OVER_RETURN');

      const mismatch = await owner.post('/api/purchase-returns').send({ supplierId: otherSupplierId, goodsReceiptId: grn1.id, warehouseId, lines: [{ productId: p2, grnLineId: grn1.line2, returnQuantity: 1 }] });
      expect(mismatch.status).toBe(400);
      expect(code(mismatch)).toBe('PURCHASE_RETURN_SUPPLIER_MISMATCH');

      const created = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: grn1.id, warehouseId, lines: [{ productId: p2, grnLineId: grn1.line2, returnQuantity: 2, unitPrice: 999 }] });
      expect(created.status).toBe(201);
      expect(created.body.returnNumber).toMatch(/^PR-\d{4}-\d{2}-\d{6}$/);
      expect(num(created.body.lines[0].unitPrice)).toBe(25); // from the receipt line, not the client
      expect(num(created.body.totalAmount)).toBe(50);
      returnId = created.body.id;

      // Submitting re-validates the return without counting its own rows.
      const submitted = await owner.post(`/api/purchase-returns/${returnId}/submit`).send({});
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');

      // 2 are now on a live return: 3 more would exceed the 4 accepted.
      const second = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: grn1.id, warehouseId, lines: [{ productId: p2, grnLineId: grn1.line2, returnQuantity: 3 }] });
      expect(second.status).toBe(400);
      expect(code(second)).toBe('PURCHASE_RETURN_OVER_RETURN');
    });

    it('is approved by someone else and, on completion, takes the goods out of stock and the value off the payable', async () => {
      expect((await owner.post(`/api/purchase-returns/${returnId}/complete`).send({})).status).toBe(400);
      expect((await owner.post(`/api/purchase-returns/${returnId}/approve`).send({})).status).toBe(403);
      const approved = await manager.post(`/api/purchase-returns/${returnId}/approve`).send({});
      expect(approved.body.status).toBe('APPROVED');

      const inventoryBefore = await readers.ledgerBalance('INVENTORY');
      const completed = await owner.post(`/api/purchase-returns/${returnId}/complete`).send({});
      expect(completed.status).toBe(201);
      expect(completed.body.status).toBe('COMPLETED');
      expect(await stockOf(p2)).toBe(2);
      expect(inventoryBefore - (await readers.ledgerBalance('INVENTORY'))).toBe(50);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(350);
      expect(await payables()).toBe(350);
    });
  });

  describe('supplier credit note', () => {
    it('is worth the sum of its lines and only an issued note can be allocated', async () => {
      const empty = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: returnId, lines: [{ productId: p2, totalAmount: 0 }] });
      expect(empty.status).toBe(400);
      expect(code(empty)).toBe('SUPPLIER_CREDIT_EMPTY');
      const mismatch = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: returnId, totalAmount: 60, lines: [{ productId: p2, quantity: 2, unitPrice: 25, totalAmount: 50 }] });
      expect(mismatch.status).toBe(400);
      expect(code(mismatch)).toBe('SUPPLIER_CREDIT_TOTAL_MISMATCH');

      const created = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: returnId, lines: [{ productId: p2, quantity: 2, unitPrice: 25, totalAmount: 50 }] });
      expect(created.status).toBe(201);
      expect(created.body.creditNumber).toMatch(/^SCN-\d{4}-\d{2}-\d{6}$/);
      expect(num(created.body.totalAmount)).toBe(50);
      expect(num(created.body.remainingBalance)).toBe(50);
      creditId = created.body.id;

      const early = await owner.post(`/api/supplier-credit-notes/${creditId}/allocate`).send({ vendorBillId: billId, amount: 50 });
      expect(early.status).toBe(400);
      expect(code(early)).toBe('SUPPLIER_CREDIT_NOT_ALLOCATABLE');

      const submitted = await owner.post(`/api/supplier-credit-notes/${creditId}/submit`).send({});
      expect(submitted.body.status).toBe('PENDING_APPROVAL');
      expect((await owner.post(`/api/supplier-credit-notes/${creditId}/approve`).send({})).status).toBe(403);
      const issued = await manager.post(`/api/supplier-credit-notes/${creditId}/approve`).send({});
      expect(issued.status).toBe(201);
      expect(issued.body.status).toBe('ISSUED');
    });

    it('allocates against a posted bill of the same supplier and settles the bill', async () => {
      const foreignBill = await owner.post('/api/vendor-bills').send({ supplierId: otherSupplierId, lines: [{ productId: p1, billedQuantity: 1, unitPrice: 10 }] });
      const wrongSupplier = await owner.post(`/api/supplier-credit-notes/${creditId}/allocate`).send({ vendorBillId: foreignBill.body.id, amount: 10 });
      expect(wrongSupplier.status).toBe(400);
      expect(code(wrongSupplier)).toBe('SUPPLIER_CREDIT_SUPPLIER_MISMATCH');

      expect((await owner.post(`/api/supplier-credit-notes/${creditId}/allocate`).send({ vendorBillId: billId, amount: 60 })).status).toBe(400);

      const allocated = await owner.post(`/api/supplier-credit-notes/${creditId}/allocate`).send({ vendorBillId: billId, amount: 50 });
      expect(allocated.status).toBe(201);
      expect(allocated.body.status).toBe('ALLOCATED');
      expect(num(allocated.body.remainingBalance)).toBe(0);
      const bill = await run.system(() => prisma.vendorBill.findUniqueOrThrow({ where: { id: billId } }));
      expect(num(bill.outstandingAmount)).toBe(100);
      expect(bill.status).toBe('PARTIALLY_PAID');

      // The rest is paid in cash; the bill is settled and refuses further payments.
      const last = await owner.post(`/api/vendor-bills/${billId}/pay`).send({ paymentAmount: 100, tender: 'CASH' });
      expect(last.body.status).toBe('PAID');
      expect(num(last.body.outstandingAmount)).toBe(0);
      const extra = await owner.post(`/api/vendor-bills/${billId}/pay`).send({ paymentAmount: 1 });
      expect(extra.status).toBe(400);
      expect(code(extra)).toBe('VENDOR_BILL_NOT_PAYABLE');
      // 600 received − 300 paid − 50 returned: the ledger and the supplier balance agree.
      expect(await payables()).toBe(250);
      expect(await readers.ledgerBalance('ACCOUNTS_PAYABLE')).toBe(250);

      const closed = await owner.post(`/api/supplier-credit-notes/${creditId}/close`).send({});
      expect(closed.body.status).toBe('CLOSED');
    });
  });

  describe('outbox relay', () => {
    it('hands PENDING purchase events to the worker as PROCESSING and the worker delivers every one of them', async () => {
      // Every purchase-family event this workflow wrote is still PENDING: the relay is a cron (off under test).
      const pending = await run.system(() => prisma.outboxEvent.findMany({ where: { shopId: shop.shopId, status: 'PENDING' }, select: { id: true, type: true } }));
      const types = new Set(pending.map((e) => e.type));
      for (const type of ['PurchaseOrderCreated', 'PurchaseOrderSubmitted', 'PurchaseOrderApproved', 'GRNCreated', 'GoodsAccepted', 'GRNCompleted', 'VendorBillSubmitted', 'VendorBillPaid', 'PurchaseReturnCompleted', 'SupplierCreditAllocated']) {
        expect(types).toContain(type);
      }

      // Each tick relays one batch, oldest first across every shop of the database; tick until this shop's rows are through.
      const ours = pending.filter((e) => isPurchaseRelayType(e.type)).map((e) => e.id);
      const relay = app.get(PurchaseOutboxRelayCron);
      for (let tick = 0; tick < 50; tick++) {
        await relay.relayPendingEvents();
        await drainOutbox();
        if ((await run.system(() => prisma.outboxEvent.count({ where: { id: { in: ours }, status: 'PENDING' } }))) === 0) break;
      }

      // Handed over as PROCESSING, delivered (listeners and webhooks) and marked DONE by the worker; nothing retried, nothing dead-lettered.
      const rows = await run.system(() => prisma.outboxEvent.findMany({ where: { id: { in: ours } }, select: { status: true, type: true, retryCount: true, processedAt: true } }));
      const notDone = rows.filter((r) => r.status !== 'DONE' || r.retryCount !== 0 || !r.processedAt).map((r) => `${r.type}:${r.status}:${r.retryCount}`);
      expect(notDone).toEqual([]);
      expect(await run.system(() => prisma.purchaseEventDelivery.count({ where: { shopId: shop.shopId, outboxEventId: { in: ours }, status: 'SUCCESS' } }))).toBeGreaterThanOrEqual(ours.length);
      expect(await run.system(() => prisma.purchaseDeadLetter.count({ where: { shopId: shop.shopId } }))).toBe(0);
      // Only the product-events family (Inventory*) is left for its own relay (roadmap 4.7).
      const leftover = pending.filter((e) => !isPurchaseRelayType(e.type)).map((e) => e.type);
      expect(leftover).toContain('InventoryReversed');
      expect(leftover.every((type) => type.startsWith('Inventory'))).toBe(true);
    });
  });

  /**
   * The relay claims up to a batch of PENDING rows across every shop of the
   * test database; waiting until none is PROCESSING keeps the worker from
   * running into the closed Prisma client when the app shuts down.
   */
  async function drainOutbox(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const processing = await run.system(() => prisma.outboxEvent.count({ where: { status: { in: ['CLAIMED', 'PROCESSING'] }, retryCount: 0 } }));
      if (processing === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

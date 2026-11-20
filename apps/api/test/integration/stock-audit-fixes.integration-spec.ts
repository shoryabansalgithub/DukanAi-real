/**
 * Release audit 2026-10-11, stock (S1, S2, S6, S16, S18 / T5, S19, S20, S23,
 * T4, T6e, #27) against the real database.
 *
 *   - a count posts counted − (snapshot + the movements up to the count):
 *     a sale during the count is not subtracted twice; one request per item
 *   - goods received into a back warehouse reach the POS through a transfer
 *   - direct adjustments: replayable, bounded, one opening, a manager's cap
 *   - reservations allocate in Decimal; variant SKUs never vanish
 *   - workflow tasks are decided by their assignee only
 */
import { INestApplication } from '@nestjs/common';
import { AdjustmentStatus, Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../../src/billing/billing.service';
import { InventoryLocationService } from '../../src/inventory-domain/services/inventory-location.service';
import { InventoryMutationEngine, MutationType } from '../../src/inventory-domain/services/inventory-mutation.engine';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WorkflowEngineService } from '../../src/procurement-workflow-domain/services/workflow-engine.service';
import { ReservationService } from '../../src/reservation-domain/services/reservation.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { AdjustmentApprovalService } from '../../src/stock-count-domain/services/adjustment-approval.service';
import { StockCountService } from '../../src/stock-count-domain/services/stock-count.service';
import { VarianceService } from '../../src/stock-count-domain/services/variance.service';
import { createUser, httpAs, ownerOf, TestUser } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, errorCode, makeReaders, num, receiveStock, tenantRunner, TestShop } from './pos-fixtures';

type Http = Awaited<ReturnType<typeof httpAs>>;
type Res = { status: number; body: { code?: string; error?: { code?: string }; [key: string]: unknown } };
const code = (res: Res) => res.body.code ?? res.body.error?.code;

describe('stock fixes (release audit 2026-10-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const openShift = (shop: TestShop) =>
    run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => app.get(ShiftsService).open({ openingCash: 1000 }, actorFor(shop, shop.cashierId, Role.CASHIER)));
  const sell = (shop: TestShop, productId: string, quantity: number, amount: number) =>
    run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
      app.get(BillingService).createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity }], payments: [{ tender: TenderType.CASH, amount }] } as never, actorFor(shop, shop.cashierId, Role.CASHIER)),
    );
  const itemOf = (shop: TestShop, productId: string, locationId = shop.saleLocationId) =>
    run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId, locationId, isDeleted: false } }));

  describe('S1 / S6: a count posts the variance at the time of counting', () => {
    let shop: TestShop;
    let manager: TestUser;
    beforeAll(async () => {
      shop = await createShop(app, 'cnt');
      manager = await createUser(app, shop, Role.MANAGER);
      await openShift(shop);
    });

    it('snapshot 100, 10 sold during the count, 90 counted: nothing to adjust; a stale request posts 0', async () => {
      const counts = app.get(StockCountService);
      const variance = app.get(VarianceService);
      const approvals = app.get(AdjustmentApprovalService);
      const a = await createProduct(app, shop, { key: 'cntA', gstRate: 'ZERO', sellingPrice: 10, costPrice: 4 });
      const b = await createProduct(app, shop, { key: 'cntB', gstRate: 'ZERO', sellingPrice: 10, costPrice: 4 });
      await receiveStock(app, shop, a, 100);
      await receiveStock(app, shop, b, 100);
      const [itemA, itemB] = [await itemOf(shop, a), await itemOf(shop, b)];

      const session = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => counts.startCountSession(shop.shopId, { type: 'SPOT_CHECK' as never }));
      await sell(shop, a, 10, 100);
      await sell(shop, b, 10, 100);

      const countedA = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => variance.calculateAndSaveVariance(shop.shopId, session.id, itemA.id, 90));
      expect(countedA).toMatchObject({ expectedQuantity: 90, variance: 0 });
      const countItemA = await run.system(() => prisma.stockCountItem.findFirstOrThrow({ where: { sessionId: session.id, inventoryItemId: itemA.id } }));
      expect(num(countItemA.expectedQuantity)).toBe(100); // the snapshot stays the snapshot
      expect(countItemA.countedAt).toBeInstanceOf(Date);
      const zero = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: itemA.id, countItemId: countItemA.id, reason: 'MANUAL_COUNT' as never })).catch((e) => e);
      expect(errorCode(zero)).toBe('ADJUSTMENT_DELTA_ZERO');

      // A request carrying the stale variance (counted − snapshot = −10) is corrected at approval and posts nothing.
      const stale = await run.system(() =>
        prisma.adjustmentRequest.create({ data: { shopId: shop.shopId, inventoryItemId: itemA.id, countItemId: countItemA.id, reason: 'MANUAL_COUNT', requestedQuantityDelta: -10, requestedById: shop.ownerId, status: AdjustmentStatus.PENDING_APPROVAL } }),
      );
      const posted = await run.as(shop.shopId, manager.id, Role.MANAGER, () => approvals.approveAdjustment(shop.shopId, stale.id, manager.id));
      expect(posted).toMatchObject({ success: true, delta: '0' });
      expect(num((await itemOf(shop, a)).onHand)).toBe(90);

      // B: 88 counted against 90 expected posts −2, once.
      const countedB = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => variance.calculateAndSaveVariance(shop.shopId, session.id, itemB.id, 88));
      expect(countedB.variance).toBe(-2);
      const countItemB = await run.system(() => prisma.stockCountItem.findFirstOrThrow({ where: { sessionId: session.id, inventoryItemId: itemB.id } }));
      const request = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: itemB.id, countItemId: countItemB.id, reason: 'MANUAL_COUNT' as never }));
      expect(num(request.requestedQuantityDelta)).toBe(-2);
      const again = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: itemB.id, countItemId: countItemB.id, reason: 'MANUAL_COUNT' as never })).catch((e) => e);
      expect(errorCode(again)).toBe('ADJUSTMENT_ALREADY_REQUESTED');
      await run.as(shop.shopId, manager.id, Role.MANAGER, () => approvals.approveAdjustment(shop.shopId, request.id, manager.id));
      expect(num((await itemOf(shop, b)).onHand)).toBe(88);
    });

    it('concurrent requests for one count item: exactly one is created', async () => {
      const counts = app.get(StockCountService);
      const variance = app.get(VarianceService);
      const approvals = app.get(AdjustmentApprovalService);
      const c = await createProduct(app, shop, { key: 'cntC', gstRate: 'ZERO', costPrice: 4 });
      await receiveStock(app, shop, c, 20);
      const item = await itemOf(shop, c);
      const session = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => counts.startCountSession(shop.shopId, { type: 'SPOT_CHECK' as never }));
      await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => variance.calculateAndSaveVariance(shop.shopId, session.id, item.id, 18));
      const countItem = await run.system(() => prisma.stockCountItem.findFirstOrThrow({ where: { sessionId: session.id, inventoryItemId: item.id } }));
      const outcomes = await Promise.allSettled(
        [1, 2, 3].map(() => run.as(shop.shopId, shop.ownerId, Role.OWNER, () => approvals.requestAdjustment(shop.shopId, shop.ownerId, { inventoryItemId: item.id, countItemId: countItem.id, reason: 'MANUAL_COUNT' as never }))),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(await run.system(() => prisma.adjustmentRequest.count({ where: { countItemId: countItem.id } }))).toBe(1);
    });
  });

  describe('S2 / S23 / #27: stock in a back warehouse reaches the POS', () => {
    let shop: TestShop;
    let owner: Http;
    let manager: Http;
    let w2: string;
    let w2Bin: string;
    beforeAll(async () => {
      shop = await createShop(app, 'xfer');
      owner = await httpAs(app, shop, ownerOf(shop));
      manager = await httpAs(app, shop, await createUser(app, shop, Role.MANAGER));
      await openShift(shop);
      const created = await owner.post('/api/warehouse-domain/warehouses').send({ code: `W2-${shop.suffix}`, name: 'Back store', type: 'MAIN' });
      expect(created.status).toBe(201);
      w2 = created.body.id;
      w2Bin = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => app.get(InventoryLocationService).resolveWarehouseBin(prisma, shop.shopId, w2));
    });

    it('received into W2, transferred to the sale location, then sold; the transfer replays and posts nothing', async () => {
      const productId = await createProduct(app, shop, { key: 'xfer', gstRate: 'ZERO', sellingPrice: 30, costPrice: 20 });
      const phone = `6${String(Date.now()).slice(-9)}`;
      const supplierId = (await owner.post('/api/suppliers').send({ name: 'Back supplier', phone })).body.id;
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 5, unitCost: 20 }] });
      await owner.post(`/api/purchases/${po.body.id}/submit`).send({});
      await manager.post(`/api/purchases/${po.body.id}/approve`).send({});

      // Two warehouses now: a receipt must name one; the named one is honoured.
      const unnamed = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: 5 }] });
      expect([unnamed.status, code(unnamed)]).toEqual([400, 'GRN_WAREHOUSE_REQUIRED']);
      const grn = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, warehouseId: w2, lines: [{ productId, receivedQuantity: 5 }] });
      await owner.post(`/api/grn/${grn.body.id}/receive`).send({ lines: [{ id: grn.body.lines[0].id, receivedQuantity: 5 }] });
      expect((await owner.post(`/api/grn/${grn.body.id}/accept`).send({})).status).toBe(201);
      expect(num((await itemOf(shop, productId, w2Bin)).onHand)).toBe(5);

      await expect(sell(shop, productId, 1, 30)).rejects.toBeDefined();

      const readers = makeReaders(app, shop);
      const inventoryBefore = await readers.ledgerBalance('INVENTORY');
      const key = randomUUID();
      const body = { productId, fromLocationId: w2Bin, toLocationId: shop.saleLocationId, quantity: 3, idempotencyKey: key };
      const cashier = await httpAs(app, shop, { id: shop.cashierId, email: '', role: Role.CASHIER });
      expect((await cashier.post('/api/inventory-domain/transfer').send(body)).status).toBe(403);
      const moved = await manager.post('/api/inventory-domain/transfer').send(body);
      expect([moved.status, moved.body]).toEqual([201, expect.objectContaining({ status: 'TRANSFERRED', from: { locationId: w2Bin, onHand: 2 }, to: { locationId: shop.saleLocationId, onHand: 3 } })]);
      const replay = await manager.post('/api/inventory-domain/transfer').send(body);
      expect([replay.status, replay.body.status]).toEqual([201, 'UNCHANGED']);
      const reused = await manager.post('/api/inventory-domain/transfer').send({ ...body, quantity: 1 });
      expect([reused.status, code(reused)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      const tooMuch = await manager.post('/api/inventory-domain/transfer').send({ ...body, quantity: 50, idempotencyKey: randomUUID() });
      expect([tooMuch.status, code(tooMuch)]).toEqual([409, 'INSUFFICIENT_STOCK']);
      expect(await readers.ledgerBalance('INVENTORY')).toBe(inventoryBefore);
      expect(await readers.productStock(productId)).toBe(5);

      const sale = await sell(shop, productId, 1, 30);
      expect(sale).toBeDefined();
      expect(await readers.onHand(productId)).toBe(2);
    });

    it('legacy stock (Product.currentStock only) opens at the sale location even when a back warehouse moves first', async () => {
      const productId = await createProduct(app, shop, { key: 'legacy', gstRate: 'ZERO', sellingPrice: 10, legacyStock: 10 });
      await receiveStock(app, shop, productId, 4, w2Bin);
      expect(num((await itemOf(shop, productId)).onHand)).toBe(10);
      expect(num((await itemOf(shop, productId, w2Bin)).onHand)).toBe(4);
      await sell(shop, productId, 10, 100);
      expect(num((await itemOf(shop, productId)).onHand)).toBe(0);
    });

    it('a system movement (no actor) is recorded under the shop owner, not the literal SYSTEM', async () => {
      const productId = await createProduct(app, shop, { key: 'sysact', gstRate: 'ZERO' });
      await run.system(() =>
        prisma.$transaction((tx) => app.get(InventoryMutationEngine).mutateStock(tx, { shopId: shop.shopId, locationId: shop.saleLocationId, productId, quantity: 2, mutationType: MutationType.PURCHASE, referenceId: `sys-${shop.suffix}`, performedBy: 'SYSTEM' })),
      );
      const log = await run.system(() => prisma.inventoryLog.findFirstOrThrow({ where: { shopId: shop.shopId, productId } }));
      expect(log.recordedById).toBe(shop.ownerId);
    });
  });

  describe('S18 / T5: direct adjustments', () => {
    let shop: TestShop;
    let owner: Http;
    let manager: Http;
    beforeAll(async () => {
      shop = await createShop(app, 'adj');
      owner = await httpAs(app, shop, ownerOf(shop));
      manager = await httpAs(app, shop, await createUser(app, shop, Role.MANAGER));
    });

    it('replays a keyed adjustment, bounds the quantity and allows one positive opening per item', async () => {
      const productId = await createProduct(app, shop, { key: 'adjk', costPrice: 10 });
      const item = (await owner.post('/api/inventory-domain').send({ productId })).body.id as string;
      expect((await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'OPENING_BALANCE', quantityChange: -5 })).status).toBe(400);
      expect((await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'OPENING_BALANCE', quantityChange: 20 })).status).toBe(201);
      const second = await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'OPENING_BALANCE', quantityChange: 20 });
      expect([second.status, code(second)]).toEqual([409, 'OPENING_STOCK_EXISTS']);
      expect((await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'CORRECTION', quantityChange: 1e12 })).status).toBe(400);
      expect((await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'CORRECTION', quantityChange: 0 })).status).toBe(400);

      const key = randomUUID();
      const first = await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'DAMAGE', quantityChange: -3, idempotencyKey: key });
      const replay = await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'DAMAGE', quantityChange: -3, idempotencyKey: key });
      expect([first.status, first.body.idempotent, replay.status, replay.body.idempotent]).toEqual([201, false, 201, true]);
      const reused = await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'DAMAGE', quantityChange: -4, idempotencyKey: key });
      expect([reused.status, code(reused)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      expect(num((await run.system(() => prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } }))).onHand)).toBe(17);
    });

    it('a manager adjusts directly only up to INVENTORY_MANAGER_MAX_ADJUST_VALUE (5000); an owner is not capped', async () => {
      const productId = await createProduct(app, shop, { key: 'adjcap', costPrice: 1000 });
      const item = (await owner.post('/api/inventory-domain').send({ productId })).body.id as string;
      const over = await manager.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'CORRECTION', quantityChange: 6 });
      expect([over.status, code(over)]).toEqual([403, 'ADJUSTMENT_REQUIRES_APPROVAL']);
      expect((await manager.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'CORRECTION', quantityChange: 5 })).status).toBe(201);
      expect((await owner.post(`/api/inventory-domain/${item}/adjust`).send({ reason: 'CORRECTION', quantityChange: 6 })).status).toBe(201);
    });
  });

  describe('S16 / T6e / S19 / S20: reservations, variants and batches', () => {
    let shop: TestShop;
    let owner: Http;
    beforeAll(async () => {
      shop = await createShop(app, 'resv');
      owner = await httpAs(app, shop, ownerOf(shop));
    });

    it('reserves 1.1 across 0.9 + 0.2 (Decimal allocation)', async () => {
      const productId = await createProduct(app, shop, { key: 'kg', unit: 'KG', gstRate: 'ZERO' });
      const created = await owner.post('/api/warehouse-domain/warehouses').send({ code: `R2-${shop.suffix}`, name: 'Cold room', type: 'MAIN' });
      const bin = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => app.get(InventoryLocationService).resolveWarehouseBin(prisma, shop.shopId, created.body.id));
      await receiveStock(app, shop, productId, 0.9);
      await receiveStock(app, shop, productId, 0.2, bin);
      const reservation = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () =>
        app.get(ReservationService).createReservation(shop.shopId, { source: 'SYSTEM' as never, expiresInSeconds: 120, items: [{ productId, requestedQuantity: 1.1 }] }),
      );
      const allocations = await run.system(() => prisma.reservationAllocation.findMany({ where: { reservationItem: { reservationId: reservation.id } }, orderBy: { allocatedQuantity: 'desc' } }));
      expect(allocations.map((a) => num(a.allocatedQuantity))).toEqual([0.9, 0.2]);
    });

    it('a variant named next to a product must be that product\'s (inventory item, batch, reservation)', async () => {
      const a = await createProduct(app, shop, { key: 'va' });
      const b = await createProduct(app, shop, { key: 'vb' });
      const variantOfB = await run.system(() => prisma.productVariant.create({ data: { shopId: shop.shopId, productId: b, sku: `VB-${shop.suffix}`, costPrice: 1, sellingPrice: 2, mrp: 2 } }));
      expect((await owner.post('/api/inventory-domain').send({ productId: a, variantId: variantOfB.id })).status).toBe(404);
      expect((await owner.post('/api/batches').send({ productId: a, variantId: variantOfB.id, batchNumber: `B-${shop.suffix}`, type: 'PURCHASE' })).status).toBe(404);
      expect((await owner.post('/api/reservations').send({ source: 'SYSTEM', expiresInSeconds: 60, items: [{ productId: a, variantId: variantOfB.id, requestedQuantity: 1 }] })).status).toBe(404);
    });

    it('a recall needs a reason and batch stock is positive', async () => {
      const productId = await createProduct(app, shop, { key: 'batch' });
      const batch = await owner.post('/api/batches').send({ productId, batchNumber: `BT-${shop.suffix}`, type: 'PURCHASE' });
      expect(batch.status).toBe(201);
      expect((await owner.post(`/api/batches/${batch.body.id}/recall`).send({})).status).toBe(400);
      const item = (await owner.post('/api/inventory-domain').send({ productId })).body.id as string;
      for (const quantity of [0, -5]) expect((await owner.post(`/api/batches/${batch.body.id}/stock`).send({ inventoryItemId: item, quantity })).status).toBe(400);
      expect((await owner.post(`/api/batches/${batch.body.id}/stock`).send({ inventoryItemId: item, quantity: 5 })).status).toBe(201);
      const recalled = await owner.post(`/api/batches/${batch.body.id}/recall`).send({ reason: 'Supplier notice' });
      expect([recalled.status, recalled.body.reason]).toEqual([201, 'Supplier notice']);
    });

    it('variant SKUs that shorten alike get unique suffixes; a SKU another product holds is a 409, never dropped', async () => {
      const a = await createProduct(app, shop, { key: 'sku' });
      const generated = await owner.post(`/api/products/${a}/variants/generate`).send({ attributes: { Colour: ['Red', 'Redwood'] } });
      expect(generated.status).toBe(201);
      expect((generated.body as Array<{ sku: string }>).map((v) => v.sku).sort()).toEqual([`sku-${shop.suffix}-RED`, `sku-${shop.suffix}-RED-2`]);
      const rerun = await owner.post(`/api/products/${a}/variants/generate`).send({ attributes: { Colour: ['Red', 'Redwood'] } });
      expect([rerun.status, (rerun.body as unknown[]).length]).toEqual([201, 2]);

      const b = await createProduct(app, shop, { key: 'other' });
      await run.system(() => prisma.productVariant.create({ data: { shopId: shop.shopId, productId: b, sku: `sku-${shop.suffix}-BLU`, costPrice: 1, sellingPrice: 2, mrp: 2 } }));
      const clash = await owner.post(`/api/products/${a}/variants/generate`).send({ attributes: { Colour: ['Blue'] } });
      expect([clash.status, code(clash)]).toEqual([409, 'VARIANT_SKU_CONFLICT']);
    });
  });

  describe('T4: workflow tasks', () => {
    it('only the assignee decides, never the document\'s author; a document gets one active workflow', async () => {
      const shop = await createShop(app, 'wf');
      const owner = await httpAs(app, shop, ownerOf(shop));
      const managerUser = await createUser(app, shop, Role.MANAGER);
      const manager = await httpAs(app, shop, managerUser);
      const other = await httpAs(app, shop, await createUser(app, shop, Role.MANAGER));
      const productId = await createProduct(app, shop, { key: 'wf' });
      const supplierId = (await owner.post('/api/suppliers').send({ name: 'WF', phone: `5${String(Date.now()).slice(-9)}` })).body.id;
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 1, unitCost: 5 }] });

      const definition = await owner.post('/api/procurement-workflows/definitions').send({ name: 'PO approval', documentType: 'PURCHASE_ORDER', steps: [{ name: 'Owner', approverId: shop.ownerId }] });
      expect(definition.status).toBe(201);
      const engine = app.get(WorkflowEngineService);
      const spawn = () => run.as(shop.shopId, shop.ownerId, Role.OWNER, () => prisma.$transaction((tx) => engine.spawnWorkflow(tx, shop.shopId, 'PURCHASE_ORDER', po.body.id, {})));
      const first = await spawn();
      expect(first).not.toBeNull();
      expect(await spawn()).toBeNull();
      const task = await run.system(() => prisma.workflowTask.findFirstOrThrow({ where: { workflowInstanceId: first!.id } }));

      // Assigned to the owner, who raised the order: separation of duties.
      const self = await owner.post(`/api/procurement-workflows/tasks/${task.id}/approve`).send({});
      expect([self.status, code(self)]).toEqual([403, 'SEPARATION_OF_DUTIES']);
      // Reassigned to the manager: another manager may not decide it; the manager's delegate may.
      await run.system(() => prisma.workflowTask.update({ where: { id: task.id }, data: { assignedUserId: managerUser.id } }));
      const stranger = await other.post(`/api/procurement-workflows/tasks/${task.id}/approve`).send({});
      expect([stranger.status, code(stranger)]).toEqual([403, 'WORKFLOW_TASK_NOT_ASSIGNED']);
      const approved = await manager.post(`/api/procurement-workflows/tasks/${task.id}/approve`).send({});
      expect(approved.status).toBe(201);
      expect((await manager.post(`/api/procurement-workflows/tasks/${task.id}/approve`).send({})).status).toBe(404);
    });
  });
});

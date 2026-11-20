/**
 * Release audit 2026-10-11, purchasing and payables (S3 / L1, S5, S8, S9,
 * S10, S11, S12, S14, S15, S17, S21, S22, S24, P1-5, #14, #28) over HTTP
 * against the real database. Every figure is read back from the tables.
 *
 *   PO 10 × ₹100 at 18 % -> receipt (AP 1000 at the net cost) -> bill 1180
 *   (DR INPUT_GST 180) -> pay 1180 -> AP and the supplier balance end at 0,
 *   the ledger balances, and a later sale's cost of goods equals what the
 *   receipt put into INVENTORY.
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../../src/billing/billing.service';
import { SupplierPayablesService } from '../../src/ledger/supplier-payables.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import request from 'supertest';
import { createUser, httpAs, issueTokens, ownerOf } from '../security/security-fixtures';
import { actorFor, bootApp, createProduct, createShop, httpTarget, num, tenantRunner, TestShop } from './pos-fixtures';

type Http = Awaited<ReturnType<typeof httpAs>>;
type Res = { status: number; body: { code?: string; error?: { code?: string }; [key: string]: unknown } };
const code = (res: Res) => res.body.code ?? res.body.error?.code;

describe('procurement and payables (release audit 2026-10-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let run: ReturnType<typeof tenantRunner>;
  let shop: TestShop;
  let owner: Http;
  let manager: Http;
  let managerId: string;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    run = tenantRunner(app);
    shop = await createShop(app, 'payab');
    const managerUser = await createUser(app, shop, Role.MANAGER);
    managerId = managerUser.id;
    owner = await httpAs(app, shop, ownerOf(shop));
    manager = await httpAs(app, shop, managerUser);
  });

  afterAll(async () => {
    await app?.close();
  });

  const balance = async (account: string) => {
    const row = await run.system(() => prisma.ledgerAccountBalance.findFirst({ where: { shopId: shop.shopId, account: account as never } }));
    return num(row?.balance);
  };
  const pending = async (supplierId: string) => num((await run.system(() => prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }))).pendingPayables);
  const fromLedger = (supplierId: string) => run.system(async () => num(await app.get(SupplierPayablesService).payablesFromLedger(prisma, shop.shopId, supplierId)));
  /** Σ debits = Σ credits over every ledger row of the shop. */
  const ledgerBalanced = async () => {
    const rows = await run.system(() => prisma.ledgerTransaction.groupBy({ by: ['type'], where: { shopId: shop.shopId }, _sum: { amount: true } }));
    const of = (type: string) => num(rows.find((r) => r.type === type)?._sum.amount);
    return { debits: of('DEBIT'), credits: of('CREDIT') };
  };
  let phoneSeq = 0;
  const newSupplier = async (extra: Record<string, unknown> = {}) => {
    const phone = `7${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(2, '0')}`;
    const res = await owner.post('/api/suppliers').send({ name: `Supplier ${phone}`, phone, ...extra });
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    return res.body.id as string;
  };

  /** PO -> approval (by the manager) -> receipt (no warehouse: the sale location's) -> received -> accepted. */
  const receiveOnOrder = async (supplierId: string, productId: string, quantity: number, unitCost: number, extra: Record<string, unknown> = {}) => {
    const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity, unitCost, cgstRate: 9, sgstRate: 9, ...extra }] });
    expect(po.status).toBe(201);
    expect((await owner.post(`/api/purchases/${po.body.id}/submit`).send({})).status).toBe(201);
    expect((await manager.post(`/api/purchases/${po.body.id}/approve`).send({})).status).toBe(201);
    const grn = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: quantity }] });
    expect([grn.status, grn.body.code]).toEqual([201, undefined]);
    expect((await owner.post(`/api/grn/${grn.body.id}/receive`).send({ lines: [{ id: grn.body.lines[0].id, receivedQuantity: quantity }] })).status).toBe(201);
    const accepted = await owner.post(`/api/grn/${grn.body.id}/accept`).send({});
    expect([accepted.status, accepted.body.code]).toEqual([201, undefined]);
    return { poId: po.body.id as string, poLineId: po.body.items[0].id as string, grnId: grn.body.id as string, grnLineId: grn.body.lines[0].id as string, warehouseId: grn.body.warehouseId as string };
  };

  const billFor = (supplierId: string, r: { poId: string; poLineId: string; grnId: string; grnLineId: string }, productId: string, line: Record<string, unknown>) =>
    owner.post('/api/vendor-bills').send({ supplierId, purchaseOrderId: r.poId, goodsReceiptId: r.grnId, lines: [{ productId, purchaseOrderLineId: r.poLineId, grnLineId: r.grnLineId, ...line }] });

  const postBill = async (billId: string) => {
    expect((await owner.post(`/api/vendor-bills/${billId}/submit`).send({})).status).toBe(201);
    expect((await manager.post(`/api/vendor-bills/${billId}/approve`).send({})).body.status).toBe('APPROVED');
    const posted = await owner.post(`/api/vendor-bills/${billId}/post`).send({});
    expect([posted.status, posted.body.status]).toEqual([201, 'POSTED']);
  };

  describe('S3 / S12: a taxed purchase is payable in full and its cost reaches the sale', () => {
    it('PO 10 × 100 at 18 %: receipt owes 1000 at net cost, the bill adds the 180 GST, paying 1180 clears the supplier', async () => {
      const productId = await createProduct(app, shop, { key: 'gst18', costPrice: 50, sellingPrice: 150 });
      const supplierId = await newSupplier();
      const apBefore = await balance('ACCOUNTS_PAYABLE');
      const inventoryBefore = await balance('INVENTORY');

      const r = await receiveOnOrder(supplierId, productId, 10, 100);
      // The receipt landed where the POS sells (no warehouse named: the sale location's).
      const saleLocation = await run.system(() => prisma.location.findUniqueOrThrow({ where: { id: shop.saleLocationId } }));
      expect(r.warehouseId).toBe(saleLocation.warehouseId);
      expect((await balance('ACCOUNTS_PAYABLE')) - apBefore).toBe(1000);
      expect((await balance('INVENTORY')) - inventoryBefore).toBe(1000);
      expect(await pending(supplierId)).toBe(1000);
      // Moving average (S12): nothing was held, so the cost is the receipt's net unit cost.
      expect(num((await run.system(() => prisma.product.findUniqueOrThrow({ where: { id: productId } }))).costPrice)).toBe(100);

      const bill = await billFor(supplierId, r, productId, { billedQuantity: 10, unitPrice: 100, taxPercentage: 18 });
      expect(bill.status).toBe(201);
      expect([num(bill.body.totalAmount as string), num(bill.body.taxAmount as string)]).toEqual([1180, 180]);
      await postBill(bill.body.id as string);
      expect(await balance('INPUT_GST')).toBe(180);
      expect((await balance('ACCOUNTS_PAYABLE')) - apBefore).toBe(1180);
      expect(await pending(supplierId)).toBe(1180);

      const paid = await owner.post(`/api/vendor-bills/${bill.body.id}/pay`).send({ paymentAmount: 1180, tender: 'BANK_TRANSFER', idempotencyKey: randomUUID() });
      expect([paid.status, paid.body.status, num(paid.body.outstandingAmount as string)]).toEqual([201, 'PAID', 0]);
      expect(await pending(supplierId)).toBe(0);
      expect((await balance('ACCOUNTS_PAYABLE')) - apBefore).toBe(0);
      expect(await fromLedger(supplierId)).toBe(0);
      const { debits, credits } = await ledgerBalanced();
      expect(debits).toBeCloseTo(credits, 2);

      // A sale takes out at cost what the receipt put in (S12): INVENTORY = 9 × 100.
      await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => app.get(ShiftsService).open({ openingCash: 1000 }, actorFor(shop, shop.cashierId, Role.CASHIER)));
      await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
        app.get(BillingService).createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 177 }] } as never, actorFor(shop, shop.cashierId, Role.CASHIER)),
      );
      expect((await balance('INVENTORY')) - inventoryBefore).toBe(900);
    });

    it('a PO line discount lowers the receipt value (net cost, GST excluded)', async () => {
      const productId = await createProduct(app, shop, { key: 'disc', costPrice: 10 });
      const supplierId = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 4, 100, { discount: 40 });
      const line = await run.system(() => prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: r.grnLineId } }));
      expect(num(line.unitPrice)).toBe(90);
      expect(await pending(supplierId)).toBe(360);
    });
  });

  describe('S8 / S9: the three-way match cannot be skipped', () => {
    it('refuses a price off the order, an unmatched line, another supplier\'s receipt and a receipt never accepted', async () => {
      const productId = await createProduct(app, shop, { key: 'match' });
      const supplierId = await newSupplier();
      const other = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 5, 40);

      const price = await billFor(supplierId, r, productId, { billedQuantity: 5, unitPrice: 41, taxPercentage: 18 });
      expect([price.status, code(price)]).toEqual([400, 'VENDOR_BILL_PRICE_MISMATCH']);

      const unmatched = await owner.post('/api/vendor-bills').send({ supplierId, goodsReceiptId: r.grnId, lines: [{ productId, billedQuantity: 1, unitPrice: 40 }] });
      expect([unmatched.status, code(unmatched)]).toEqual([400, 'VENDOR_BILL_LINE_UNMATCHED']);

      const foreign = await owner.post('/api/vendor-bills').send({ supplierId: other, lines: [{ productId, purchaseOrderLineId: r.poLineId, grnLineId: r.grnLineId, billedQuantity: 1, unitPrice: 40 }] });
      expect([foreign.status, code(foreign)]).toEqual([400, 'VENDOR_BILL_SUPPLIER_MISMATCH']);

      // A bill without references may be drafted, never submitted.
      const loose = await owner.post('/api/vendor-bills').send({ supplierId, lines: [{ productId, billedQuantity: 1, unitPrice: 40 }] });
      expect(loose.status).toBe(201);
      const submitted = await owner.post(`/api/vendor-bills/${loose.body.id}/submit`).send({});
      expect([submitted.status, code(submitted)]).toEqual([400, 'VENDOR_BILL_LINE_UNMATCHED']);

      // A receipt still in RECEIVING has no accepted goods to bill or return.
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 2, unitCost: 40 }] });
      await owner.post(`/api/purchases/${po.body.id}/submit`).send({});
      await manager.post(`/api/purchases/${po.body.id}/approve`).send({});
      const grn = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: 2 }] });
      await owner.post(`/api/grn/${grn.body.id}/receive`).send({ lines: [{ id: grn.body.lines[0].id, receivedQuantity: 2 }] });
      const early = await owner.post('/api/vendor-bills').send({ supplierId, lines: [{ productId, purchaseOrderLineId: po.body.items[0].id, grnLineId: grn.body.lines[0].id, billedQuantity: 2, unitPrice: 40 }] });
      expect([early.status, code(early)]).toEqual([400, 'VENDOR_BILL_RECEIPT_NOT_ACCEPTED']);
      const earlyReturn = await owner.post('/api/purchase-returns').send({ supplierId, lines: [{ productId, grnLineId: grn.body.lines[0].id, returnQuantity: 1 }] });
      expect([earlyReturn.status, code(earlyReturn)]).toEqual([400, 'PURCHASE_RETURN_RECEIPT_NOT_ACCEPTED']);
    });
  });

  describe('S5 / S14: one bill, two payments at once', () => {
    it('two concurrent payments of the whole outstanding pay it once', async () => {
      const productId = await createProduct(app, shop, { key: 'race' });
      const supplierId = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 2, 50);
      const bill = await billFor(supplierId, r, productId, { billedQuantity: 2, unitPrice: 50, taxPercentage: 18 });
      await postBill(bill.body.id as string);

      const results = await Promise.all([1, 2].map(() => owner.post(`/api/vendor-bills/${bill.body.id}/pay`).send({ paymentAmount: 118, tender: 'UPI', idempotencyKey: randomUUID() })));
      expect(results.map((x) => x.status).sort()).toEqual([201, 400]);
      expect(await run.system(() => prisma.supplierPayment.count({ where: { vendorBillId: bill.body.id as string } }))).toBe(1);
      expect(await pending(supplierId)).toBe(0);
    });
  });

  describe('S5 / S14: credit-note allocations and receipt acceptance under concurrency', () => {
    it('two concurrent allocations of a note\'s whole balance apply it once', async () => {
      const productId = await createProduct(app, shop, { key: 'alloc' });
      const supplierId = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 10, 20);
      const bill = await billFor(supplierId, r, productId, { billedQuantity: 10, unitPrice: 20 });
      await postBill(bill.body.id as string);
      const note = await owner.post('/api/supplier-credit-notes').send({ supplierId, lines: [{ totalAmount: 50 }] });
      await owner.post(`/api/supplier-credit-notes/${note.body.id}/submit`).send({});
      await manager.post(`/api/supplier-credit-notes/${note.body.id}/approve`).send({});

      const results = await Promise.all([1, 2].map(() => owner.post(`/api/supplier-credit-notes/${note.body.id}/allocate`).send({ vendorBillId: bill.body.id, amount: 50 })));
      expect(results.map((x) => x.status).sort()).toEqual([201, 400]);
      const [after, scn] = await run.system(() => Promise.all([
        prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.body.id as string } }),
        prisma.supplierCreditNote.findUniqueOrThrow({ where: { id: note.body.id as string } }),
      ]));
      expect([num(after.outstandingAmount), after.status, num(scn.remainingBalance)]).toEqual([150, 'PARTIALLY_PAID', 0]);
      expect(await run.system(() => prisma.supplierCreditAllocation.count({ where: { supplierCreditId: note.body.id as string } }))).toBe(1);
    });

    it('two concurrent acceptances of one receipt stock it once', async () => {
      const productId = await createProduct(app, shop, { key: 'accept2' });
      const supplierId = await newSupplier();
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 4, unitCost: 10 }] });
      await owner.post(`/api/purchases/${po.body.id}/submit`).send({});
      await manager.post(`/api/purchases/${po.body.id}/approve`).send({});
      const grn = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: 4 }] });
      await owner.post(`/api/grn/${grn.body.id}/receive`).send({ lines: [{ id: grn.body.lines[0].id, receivedQuantity: 4 }] });
      const results = await Promise.all([1, 2].map(() => owner.post(`/api/grn/${grn.body.id}/accept`).send({})));
      expect(results.map((x) => x.status).sort()).toEqual([201, 400]);
      const stock = await run.system(() => prisma.inventoryItem.aggregate({ where: { shopId: shop.shopId, productId }, _sum: { onHand: true } }));
      expect(num(stock._sum.onHand)).toBe(4);
      expect(await pending(supplierId)).toBe(40);
    });
  });

  describe('P1-5 / #14: a supplier payment is recorded once and cash leaves the drawer', () => {
    it('two concurrent POSTs with one key make one payment; without a key the API refuses', async () => {
      const supplierId = await newSupplier({ openingBalance: 500 });
      const noKey = await owner.post(`/api/suppliers/${supplierId}/payments`).send({ amount: 10, tender: 'UPI' });
      expect(noKey.status).toBe(400);

      const key = randomUUID();
      const results = await Promise.all([1, 2, 3].map(() => owner.post(`/api/suppliers/${supplierId}/payments`).send({ amount: 120, tender: 'UPI', idempotencyKey: key })));
      expect(results.map((x) => x.status)).toEqual([201, 201, 201]);
      expect(results.filter((x) => (x.body.payment as { replayed: boolean }).replayed).length).toBe(2);
      expect(await run.system(() => prisma.supplierPayment.count({ where: { supplierId } }))).toBe(1);
      expect(await pending(supplierId)).toBe(380);

      const reused = await owner.post(`/api/suppliers/${supplierId}/payments`).send({ amount: 121, tender: 'UPI', idempotencyKey: key });
      expect([reused.status, code(reused)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    });

    it('a CASH payment by someone with an open shift is taken from that drawer', async () => {
      const supplierId = await newSupplier({ openingBalance: 300 });
      const shift = await run.as(shop.shopId, managerId, Role.MANAGER, () => app.get(ShiftsService).open({ openingCash: 1000 }, actorFor(shop, managerId, Role.MANAGER)));
      const paid = await manager.post(`/api/suppliers/${supplierId}/payments`).send({ amount: 200, tender: 'CASH', idempotencyKey: randomUUID() });
      expect(paid.status).toBe(201);
      const payment = await run.system(() => prisma.supplierPayment.findFirstOrThrow({ where: { supplierId } }));
      expect(payment.shiftId).toBe(shift.id);
      const after = await run.system(() => prisma.shift.findUniqueOrThrow({ where: { id: shift.id } }));
      expect([num(after.expectedCash), num(after.cashPayouts)]).toEqual([800, 200]);
    });
  });

  describe('S11 / S17 / L12 / S21 / #28: opening balances, advances, deletion', () => {
    it('an opening balance is posted, and payablesFromLedger agrees with the supplier', async () => {
      const equityBefore = await balance('OPENING_BALANCE_EQUITY');
      const apBefore = await balance('ACCOUNTS_PAYABLE');
      const supplierId = await newSupplier({ openingBalance: 250.5 });
      expect((await balance('ACCOUNTS_PAYABLE')) - apBefore).toBeCloseTo(250.5, 2);
      expect((await balance('OPENING_BALANCE_EQUITY')) - equityBefore).toBeCloseTo(-250.5, 2);
      const posting = await run.system(() => prisma.ledgerPosting.findFirst({ where: { shopId: shop.shopId, sourceType: 'SUPPLIER_OPENING_BALANCE', sourceId: supplierId } }));
      expect(posting).not.toBeNull();
      expect(await fromLedger(supplierId)).toBe(250.5);
    });

    it('goods returned after the bill was paid leave the supplier holding an advance (negative, not floored)', async () => {
      const productId = await createProduct(app, shop, { key: 'adv' });
      const supplierId = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 4, 25);
      const bill = await billFor(supplierId, r, productId, { billedQuantity: 4, unitPrice: 25 });
      await postBill(bill.body.id as string);
      expect((await owner.post(`/api/vendor-bills/${bill.body.id}/pay`).send({ paymentAmount: 100, tender: 'BANK_TRANSFER' })).status).toBe(201);
      expect(await pending(supplierId)).toBe(0);

      const pr = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: r.grnId, lines: [{ productId, grnLineId: r.grnLineId, returnQuantity: 2 }] });
      expect([pr.status, pr.body.warehouseId]).toEqual([201, r.warehouseId]);
      await owner.post(`/api/purchase-returns/${pr.body.id}/submit`).send({});
      await manager.post(`/api/purchase-returns/${pr.body.id}/approve`).send({});
      expect((await owner.post(`/api/purchase-returns/${pr.body.id}/complete`).send({})).status).toBe(201);
      expect(await pending(supplierId)).toBe(-50);
      expect(await fromLedger(supplierId)).toBe(-50);

      // A supplier with any balance (an advance too) cannot be deleted.
      const refused = await owner.delete(`/api/suppliers/${supplierId}`);
      expect([refused.status, code(refused as Res)]).toEqual([409, 'SUPPLIER_HAS_BALANCE']);

      // #28: the page's tiles total every supplier, advances included, not the first page of the list.
      const summary = await owner.get('/api/suppliers/summary');
      expect(summary.status).toBe(200);
      const [total, count] = await run.system(() => Promise.all([
        prisma.supplier.aggregate({ where: { shopId: shop.shopId, isDeleted: false }, _sum: { pendingPayables: true } }),
        prisma.supplier.count({ where: { shopId: shop.shopId, isDeleted: false } }),
      ]));
      expect(summary.body).toEqual({ totalPayables: num(total._sum.pendingPayables).toFixed(2), count, activeCount: count });
    });

    it('a settled supplier can be deleted, and then takes no new documents (404)', async () => {
      const productId = await createProduct(app, shop, { key: 'gone' });
      const supplierId = await newSupplier();
      expect((await owner.delete(`/api/suppliers/${supplierId}`)).status).toBe(200);
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 1, unitCost: 1 }] });
      expect(po.status).toBe(404);
      const bill = await owner.post('/api/vendor-bills').send({ supplierId, lines: [{ productId, billedQuantity: 1, unitPrice: 1 }] });
      expect(bill.status).toBe(404);
      const note = await owner.post('/api/supplier-credit-notes').send({ supplierId, lines: [{ productId, totalAmount: 1 }] });
      expect(note.status).toBe(404);
    });
  });

  describe('S10: credit notes move the payable when they are issued', () => {
    it('a price-difference note: DR AP 118 / CR INPUT_GST 18 / CR INVENTORY 100 at issue', async () => {
      const supplierId = await newSupplier({ openingBalance: 1000 });
      const [gst, inventory] = [await balance('INPUT_GST'), await balance('INVENTORY')];
      const note = await owner.post('/api/supplier-credit-notes').send({ supplierId, creditSource: 'PRICE_DIFFERENCE', lines: [{ description: 'Rate difference', taxAmount: 18, totalAmount: 118 }] });
      expect(note.status).toBe(201);
      await owner.post(`/api/supplier-credit-notes/${note.body.id}/submit`).send({});
      const issued = await manager.post(`/api/supplier-credit-notes/${note.body.id}/approve`).send({});
      expect(issued.body.status).toBe('ISSUED');
      expect(await pending(supplierId)).toBe(882);
      expect(await fromLedger(supplierId)).toBe(882);
      expect((await balance('INPUT_GST')) - gst).toBe(-18);
      expect((await balance('INVENTORY')) - inventory).toBe(-100);
    });

    it('a return-backed note needs the COMPLETED return, adds only the return\'s GST and never exceeds the return', async () => {
      const productId = await createProduct(app, shop, { key: 'retnote' });
      const supplierId = await newSupplier();
      const r = await receiveOnOrder(supplierId, productId, 5, 20);
      const pr = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: r.grnId, lines: [{ productId, grnLineId: r.grnLineId, returnQuantity: 5, taxPercentage: 18 }] });
      expect(num(pr.body.totalAmount as string)).toBe(118);

      const tooEarly = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: pr.body.id, lines: [{ productId, taxAmount: 18, totalAmount: 118 }] });
      expect([tooEarly.status, code(tooEarly)]).toEqual([409, 'SUPPLIER_CREDIT_RETURN_NOT_COMPLETED']);

      await owner.post(`/api/purchase-returns/${pr.body.id}/submit`).send({});
      await manager.post(`/api/purchase-returns/${pr.body.id}/approve`).send({});
      await owner.post(`/api/purchase-returns/${pr.body.id}/complete`).send({});
      expect(await pending(supplierId)).toBe(0); // the return took the 100 off

      const first = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: pr.body.id, lines: [{ productId, taxAmount: 18, totalAmount: 118 }] });
      expect(first.status).toBe(201);
      const second = await owner.post('/api/supplier-credit-notes').send({ supplierId, purchaseReturnId: pr.body.id, lines: [{ productId, totalAmount: 1 }] });
      expect([second.status, code(second)]).toEqual([400, 'SUPPLIER_CREDIT_EXCEEDS_RETURN']);

      await owner.post(`/api/supplier-credit-notes/${first.body.id}/submit`).send({});
      expect((await manager.post(`/api/supplier-credit-notes/${first.body.id}/approve`).send({})).body.status).toBe('ISSUED');
      // Only the GST above the return's posted value moves the payable: −18, an advance.
      expect(await pending(supplierId)).toBe(-18);
      expect(await fromLedger(supplierId)).toBe(-18);
    });
  });

  describe('S24: reject and cancel', () => {
    it('a return, a bill, a credit note and a receipt can be refused or withdrawn before they move anything', async () => {
      const productId = await createProduct(app, shop, { key: 'rejcan' });
      const supplierId = await newSupplier({ openingBalance: 100 });
      const r = await receiveOnOrder(supplierId, productId, 3, 10);

      const pr = await owner.post('/api/purchase-returns').send({ supplierId, goodsReceiptId: r.grnId, lines: [{ productId, grnLineId: r.grnLineId, returnQuantity: 1 }] });
      await owner.post(`/api/purchase-returns/${pr.body.id}/submit`).send({});
      const selfReject = await owner.post(`/api/purchase-returns/${pr.body.id}/reject`).send({ comments: 'mine' });
      expect([selfReject.status, code(selfReject)]).toEqual([403, 'SEPARATION_OF_DUTIES']);
      const rejected = await manager.post(`/api/purchase-returns/${pr.body.id}/reject`).send({ comments: 'not damaged' });
      expect([rejected.status, rejected.body.status]).toEqual([201, 'REJECTED']);
      expect((await owner.post(`/api/purchase-returns/${pr.body.id}/complete`).send({})).status).toBe(400);

      const bill = await billFor(supplierId, r, productId, { billedQuantity: 3, unitPrice: 10 });
      await owner.post(`/api/vendor-bills/${bill.body.id}/submit`).send({});
      const cancelled = await owner.post(`/api/vendor-bills/${bill.body.id}/cancel`).send({ comments: 'wrong invoice' });
      expect([cancelled.status, cancelled.body.status]).toEqual([201, 'CANCELLED']);
      expect((await manager.post(`/api/vendor-bills/${bill.body.id}/approve`).send({})).status).toBe(400);
      expect(await run.system(() => prisma.vendorBillApproval.count({ where: { vendorBillId: bill.body.id as string, status: 'PENDING' } }))).toBe(0);

      const bill2 = await billFor(supplierId, r, productId, { billedQuantity: 3, unitPrice: 10 });
      await owner.post(`/api/vendor-bills/${bill2.body.id}/submit`).send({});
      expect((await manager.post(`/api/vendor-bills/${bill2.body.id}/reject`).send({})).body.status).toBe('REJECTED');

      const note = await owner.post('/api/supplier-credit-notes').send({ supplierId, lines: [{ totalAmount: 5 }] });
      expect((await owner.post(`/api/supplier-credit-notes/${note.body.id}/cancel`).send({})).body.status).toBe('CANCELLED');
      const note2 = await owner.post('/api/supplier-credit-notes').send({ supplierId, lines: [{ totalAmount: 5 }] });
      await owner.post(`/api/supplier-credit-notes/${note2.body.id}/submit`).send({});
      expect((await manager.post(`/api/supplier-credit-notes/${note2.body.id}/reject`).send({})).body.status).toBe('REJECTED');
      expect(await pending(supplierId)).toBe(130);

      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 2, unitCost: 10 }] });
      await owner.post(`/api/purchases/${po.body.id}/submit`).send({});
      await manager.post(`/api/purchases/${po.body.id}/approve`).send({});
      const grn = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: 2 }] });
      const grnCancelled = await owner.post(`/api/grn/${grn.body.id}/cancel`).send({});
      expect([grnCancelled.status, grnCancelled.body.status]).toEqual([201, 'CANCELLED']);
      const grn2 = await owner.post('/api/grn').send({ purchaseOrderId: po.body.id, supplierId, lines: [{ productId, receivedQuantity: 2 }] });
      await owner.post(`/api/grn/${grn2.body.id}/receive`).send({ lines: [{ id: grn2.body.lines[0].id, receivedQuantity: 2 }] });
      expect((await owner.post(`/api/grn/${grn2.body.id}/reject`).send({})).status).toBe(403);
      expect((await manager.post(`/api/grn/${grn2.body.id}/reject`).send({})).body.status).toBe('REJECTED');
      expect((await owner.post(`/api/grn/${grn2.body.id}/accept`).send({})).status).toBe(400);
    });
  });

  describe('S22: a draft is totalled by the server and its editor cannot approve it', () => {
    it('ignores a client total, re-taxes the lines, and refuses the editor as approver', async () => {
      const productId = await createProduct(app, shop, { key: 'draft' });
      const supplierId = await newSupplier();
      const po = await owner.post('/api/purchases').send({ supplierId, items: [{ productId, quantity: 1, unitCost: 10 }] });
      const token = (await issueTokens(app, { id: managerId })).access_token;
      const edited = await request(httpTarget(app)).put(`/api/purchases/${po.body.id}/draft`).set('Authorization', `Bearer ${token}`).send({ totalAmount: 1, items: [{ productId, quantity: 3, unitCost: 100, cgstRate: 9, sgstRate: 9 }] });
      expect([edited.status, num(edited.body.totalAmount as string)]).toEqual([200, 354]);
      expect((await owner.post(`/api/purchases/${po.body.id}/submit`).send({})).status).toBe(201);
      const byEditor = await manager.post(`/api/purchases/${po.body.id}/approve`).send({});
      expect([byEditor.status, code(byEditor)]).toEqual([403, 'SEPARATION_OF_DUTIES']);
    });
  });
});

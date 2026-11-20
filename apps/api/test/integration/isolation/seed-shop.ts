import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bearerToken, createUser, ownerOf, TestUser } from '../../security/security-fixtures';
import { createProduct, createShop, httpTarget, receiveStock, tenantRunner, TestShop } from '../pos-fixtures';

/**
 * A shop with a row in nearly every table a shop owns, made through the
 * routes its people use (sales, returns, cancellations, repayments,
 * expenses with a receipt, the whole purchasing chain, stock counts,
 * reservations, batches, warehouses, variants, revisions, barcodes, media,
 * stored documents, imports, webhooks, invitations, workflow definitions,
 * search history, reconciliation). Every free text carries `marker`, so a
 * leak of any of it into another shop's answer is one substring search.
 */

/** A real 1x1 PNG: the media worker decodes uploads to make thumbnails, and a broken one keeps retrying in the background. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(512, 0x11)]);
export const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20)]);

/** Every seeded owner signs in with this (the ownership transfer asks for it). */
export const OWNER_PASSWORD = 'Correct-Horse-Battery-9';

export interface SeededShop {
  shop: TestShop;
  marker: string;
  users: Record<'owner' | 'admin' | 'manager' | 'approver' | 'cashier' | 'viewer', TestUser>;
  tokens: Record<'owner' | 'admin' | 'manager' | 'approver' | 'cashier' | 'viewer', string>;
  /** Named rows the suite refers to directly. */
  ids: Record<string, string>;
  /** The amount of the shop's one completed cash sale, different per shop so reports can be told apart. */
  saleTotal: number;
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

export function client(app: INestApplication, token: string) {
  const call = (method: Method, url: string) => request(httpTarget(app))[method](url).set('Authorization', `Bearer ${token}`);
  /** A call that must answer one of `expected`; the body is returned. */
  const must = async (method: Method, url: string, body?: unknown, expected: number[] = [200, 201]) => {
    let req = call(method, url);
    if (body !== undefined) req = req.send(body as object);
    const res = await req;
    if (!expected.includes(res.status)) throw new Error(`seed: ${method.toUpperCase()} ${url} -> ${res.status} ${res.text.slice(0, 400)}`);
    return res.body as Record<string, unknown> & { id: string };
  };
  return { call, must };
}

export async function seedShop(app: INestApplication, label: string, units: number): Promise<SeededShop> {
  const prisma = app.get(PrismaService);
  const run = tenantRunner(app);
  const marker = `Mk${label}${Date.now().toString(36)}`;
  const shop = await createShop(app, label, { creditLimit: 100000 });
  const users = {
    owner: ownerOf(shop),
    admin: await createUser(app, shop, Role.ADMIN),
    manager: await createUser(app, shop, Role.MANAGER),
    approver: await createUser(app, shop, Role.MANAGER),
    cashier: { id: shop.cashierId, email: `cashier-${shop.suffix}@test.local`, role: Role.CASHIER } as TestUser,
    viewer: await createUser(app, shop, Role.VIEWER),
  };
  const tokens = {
    owner: await bearerToken(app, shop, users.owner),
    admin: await bearerToken(app, shop, users.admin),
    manager: await bearerToken(app, shop, users.manager),
    approver: await bearerToken(app, shop, users.approver),
    cashier: await bearerToken(app, shop, users.cashier),
    viewer: await bearerToken(app, shop, users.viewer),
  };
  const owner = client(app, tokens.owner);
  const approver = client(app, tokens.approver);
  const admin = client(app, tokens.admin);
  await run.system(async () => prisma.user.update({ where: { id: shop.ownerId }, data: { password: await bcrypt.hash(OWNER_PASSWORD, 4) } }));
  const digits = shop.suffix.replace(/\D/g, '').slice(-8).padStart(8, '3');
  const ids: Record<string, string> = { customer: shop.customerId };

  await run.system(() =>
    prisma.customer.update({ where: { id: shop.customerId }, data: { name: `Cust ${marker}`, email: `c.${marker.toLowerCase()}@mail.test`, address: `12 ${marker} Road`, notes: `likes ${marker}` } }),
  );
  await owner.must('patch', '/api/shops/me', { name: `Shop ${marker}`, address: `1 ${marker} Market` });

  // Catalogue
  ids.category = (await owner.must('post', '/api/categories', { name: `Cat ${marker}` })).id;
  ids.subCategory = (await owner.must('post', '/api/categories', { name: `Sub ${marker}`, parentId: ids.category })).id;
  ids.supplier = (await owner.must('post', '/api/suppliers', { name: `Supplier ${marker}`, contactPerson: `Contact ${marker}`, phone: `7${digits}1`, openingBalance: 500 })).id;
  ids.product = await createProduct(app, shop, { key: 'p1', sellingPrice: 100, gstRate: 'ZERO' });
  ids.product2 = await createProduct(app, shop, { key: 'p2', sellingPrice: 50, costPrice: 30, gstRate: 'ZERO', reorderPoint: 500 });
  ids.product3 = (
    await owner.must('post', '/api/products', { name: `Prod ${marker}`, costPrice: 40, sellingPrice: 80, wholesalePrice: 70, gstRate: 'ZERO', unit: 'PCS', categoryId: ids.subCategory, supplierId: ids.supplier })
  ).id;
  await receiveStock(app, shop, ids.product, 100);
  await receiveStock(app, shop, ids.product2, 100);
  const variants = await owner.must('post', `/api/products/${ids.product3}/variants/generate`, { attributes: { Colour: [`Red${label}`, `Blue${label}`] } });
  ids.variant = (await run.system(() => prisma.productVariant.findFirstOrThrow({ where: { shopId: shop.shopId, productId: ids.product3 } }))).id;
  void variants;
  ids.barcode = `BC${digits}${label.length}`;
  await owner.must('post', `/api/product-identity/products/${ids.product2}/barcode`, { code: ids.barcode, format: 'CODE128' });
  // Revisions in every state a route acts on: PENDING_REVIEW (approve), APPROVED (publish), DRAFT (edit, submit).
  ids.revision = (await owner.must('post', `/api/products/${ids.product}/revisions/draft`)).id;
  await owner.must('post', `/api/products/${ids.product}/revisions/${ids.revision}/submit`);
  ids.revision2 = (await owner.must('post', `/api/products/${ids.product2}/revisions/draft`)).id;
  await owner.must('post', `/api/products/${ids.product2}/revisions/${ids.revision2}/submit`);
  await admin.must('post', `/api/products/${ids.product2}/revisions/${ids.revision2}/approve`, {});
  ids.revision3 = (await owner.must('post', `/api/products/${ids.product3}/revisions/draft`)).id;
  await owner.must('post', `/api/products/${ids.product}/validate`);

  // Warehouses and stock
  ids.warehouse = (await owner.must('post', '/api/warehouse-domain/warehouses', { code: `WH-${shop.suffix}`, name: `Store ${marker}`, type: 'MAIN', city: 'Bengaluru' })).id;
  ids.zone = (await owner.must('post', '/api/warehouse-domain/locations', { warehouseId: ids.warehouse, type: 'ZONE', code: 'Z1' })).id;
  ids.rack = (await owner.must('post', '/api/warehouse-domain/locations', { warehouseId: ids.warehouse, parentId: ids.zone, type: 'RACK', code: 'R1' })).id;
  const item = await run.system(() => prisma.inventoryItem.findFirstOrThrow({ where: { shopId: shop.shopId, productId: ids.product, locationId: shop.saleLocationId } }));
  ids.inventoryItem = item.id;
  ids.saleLocation = shop.saleLocationId;
  await owner.must('post', '/api/inventory-domain/transfer', { productId: ids.product, fromLocationId: shop.saleLocationId, toLocationId: ids.rack, quantity: 2, idempotencyKey: randomUUID() });
  ids.batch = (await owner.must('post', '/api/batches', { productId: ids.product, batchNumber: `B-${marker}`, type: 'PURCHASE', expiryDate: new Date(Date.now() + 5 * 86_400_000).toISOString() })).id;
  await owner.must('post', `/api/batches/${ids.batch}/stock`, { inventoryItemId: ids.inventoryItem, quantity: 5 });
  ids.reservation = (await owner.must('post', '/api/reservations', { source: 'POS', expiresInSeconds: 3600, items: [{ productId: ids.product, requestedQuantity: 1 }] })).id;
  ids.countSession = (await owner.must('post', '/api/stock-counts/sessions', { type: 'FULL_COUNT', assignedToUserId: users.manager.id })).id;
  await owner.must('put', `/api/stock-counts/sessions/${ids.countSession}/items`, { inventoryItemId: ids.inventoryItem, countedQuantity: 90, notes: `count ${marker}` });
  ids.adjustment = (await owner.must('post', '/api/stock-counts/adjustments', { inventoryItemId: ids.inventoryItem, reason: 'CORRECTION', requestedQuantityDelta: -1 })).id;

  // Sales: a cash sale, a credit sale, a return, a cancellation, a repayment
  await owner.must('post', '/api/shifts/open', { openingCash: 500 });
  const cashier = client(app, tokens.cashier);
  await cashier.must('post', '/api/shifts/open', { openingCash: 100 });
  const sale = await owner.must('post', '/api/billing/invoice', {
    idempotencyKey: randomUUID(),
    customerId: shop.customerId,
    notes: `for ${marker}`,
    items: [{ productId: ids.product, quantity: units }],
    payments: [{ tender: 'CASH', amount: 100 * units }],
  });
  const invoice = sale.invoice as { id: string; items: Array<{ id: string }> };
  ids.invoice = invoice.id;
  ids.invoiceItem = invoice.items[0].id;
  const credit = await owner.must('post', '/api/billing/invoice', { idempotencyKey: randomUUID(), customerId: shop.customerId, items: [{ productId: ids.product2, quantity: 2 }], payments: [], udharAmount: 100 });
  ids.creditInvoice = (credit.invoice as { id: string }).id;
  const toCancel = await cashier.must('post', '/api/billing/invoice', { idempotencyKey: randomUUID(), items: [{ productId: ids.product2, quantity: 1 }], payments: [{ tender: 'UPI', amount: 50 }] });
  ids.cancelledInvoice = (toCancel.invoice as { id: string }).id;
  await owner.must('post', `/api/billing/invoices/${ids.cancelledInvoice}/cancel`, { reason: `mistake ${marker}` });
  const refund = await owner.must('post', '/api/billing/returns', { idempotencyKey: randomUUID(), invoiceId: ids.invoice, items: [{ invoiceItemId: ids.invoiceItem, quantity: 1 }], reason: 'CUSTOMER_REQUEST', notes: `back ${marker}` });
  ids.returnInvoice = (refund.invoice as { id: string }).id;
  await owner.must('post', `/api/customers/${shop.customerId}/payments`, { idempotencyKey: randomUUID(), amount: 40, tender: 'CASH', notes: `paid by ${marker}` });
  ids.shift = (await run.system(() => prisma.shift.findFirstOrThrow({ where: { shopId: shop.shopId, openedById: shop.ownerId } }))).id;
  ids.customer2 = (await owner.must('post', '/api/customers', { name: `Second ${marker}`, phone: `6${digits}2` })).id;

  // Expenses with a receipt
  ids.expense = (await owner.must('post', '/api/expenses', { category: 'OTHER', amount: 75, description: `tea for ${marker}`, isPaid: true, paymentMode: 'Cash' })).id;
  const receipt = await owner.call('post', `/api/expenses/${ids.expense}/receipt`).attach('file', JPEG, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
  if (receipt.status >= 300) throw new Error(`seed: expense receipt -> ${receipt.status} ${receipt.text}`);

  // Purchasing: order -> approval -> receipt -> bill -> payment, return -> credit note -> allocation
  const po = await owner.must('post', '/api/purchases', { supplierId: ids.supplier, notes: `po ${marker}`, items: [{ productId: ids.product2, quantity: 10, unitCost: 30 }] });
  ids.purchaseOrder = po.id;
  ids.purchaseOrderItem = (po.items as Array<{ id: string }>)[0].id;
  await owner.must('post', `/api/purchases/${ids.purchaseOrder}/submit`, {});
  await approver.must('post', `/api/purchases/${ids.purchaseOrder}/approve`, { comments: `ok ${marker}` });
  const grn = await owner.must('post', '/api/grn', { purchaseOrderId: ids.purchaseOrder, supplierId: ids.supplier, warehouseId: ids.warehouse, lines: [{ purchaseOrderItemId: ids.purchaseOrderItem, productId: ids.product2, receivedQuantity: 10 }] });
  ids.goodsReceipt = grn.id;
  ids.goodsReceiptLine = (grn.lines as Array<{ id: string }>)[0].id;
  await owner.must('post', `/api/grn/${ids.goodsReceipt}/receive`, { lines: [{ id: ids.goodsReceiptLine, receivedQuantity: 10 }] });
  await owner.must('post', `/api/grn/${ids.goodsReceipt}/inspect`, { status: 'PASS', lines: [{ id: ids.goodsReceiptLine, acceptedQuantity: 10 }] });
  await owner.must('post', `/api/grn/${ids.goodsReceipt}/accept`, {});
  const bill = await owner.must('post', '/api/vendor-bills', {
    supplierId: ids.supplier,
    purchaseOrderId: ids.purchaseOrder,
    goodsReceiptId: ids.goodsReceipt,
    lines: [{ productId: ids.product2, billedQuantity: 10, unitPrice: 30, grnLineId: ids.goodsReceiptLine, purchaseOrderLineId: ids.purchaseOrderItem }],
  });
  ids.vendorBill = bill.id;
  await owner.must('post', `/api/vendor-bills/${ids.vendorBill}/submit`, {});
  await approver.must('post', `/api/vendor-bills/${ids.vendorBill}/approve`, {});
  await owner.must('post', `/api/vendor-bills/${ids.vendorBill}/post`, {});
  await owner.must('post', `/api/vendor-bills/${ids.vendorBill}/pay`, { paymentAmount: 100, tender: 'CASH', idempotencyKey: `pay-${shop.suffix}` });
  const purchaseReturn = await owner.must('post', '/api/purchase-returns', { supplierId: ids.supplier, goodsReceiptId: ids.goodsReceipt, warehouseId: ids.warehouse, lines: [{ productId: ids.product2, grnLineId: ids.goodsReceiptLine, returnQuantity: 1 }] });
  ids.purchaseReturn = purchaseReturn.id;
  await owner.must('post', `/api/purchase-returns/${ids.purchaseReturn}/submit`, {});
  await approver.must('post', `/api/purchase-returns/${ids.purchaseReturn}/approve`, {});
  await owner.must('post', `/api/purchase-returns/${ids.purchaseReturn}/complete`, {});
  ids.creditNote = (await owner.must('post', '/api/supplier-credit-notes', { supplierId: ids.supplier, purchaseReturnId: ids.purchaseReturn, lines: [{ productId: ids.product2, quantity: 1, unitPrice: 30, totalAmount: 30 }] })).id;
  await owner.must('post', `/api/supplier-credit-notes/${ids.creditNote}/submit`, {});
  await approver.must('post', `/api/supplier-credit-notes/${ids.creditNote}/approve`, {});
  await owner.must('post', `/api/supplier-credit-notes/${ids.creditNote}/allocate`, { vendorBillId: ids.vendorBill, amount: 30 });
  await owner.must('post', `/api/suppliers/${ids.supplier}/payments`, { amount: 50, tender: 'CASH', idempotencyKey: randomUUID() });
  // A second order left SUBMITTED, so a workflow task and a pending approval exist.
  ids.workflowDefinition = (await owner.must('post', '/api/procurement-workflows/definitions', { name: `Flow ${marker}`, documentType: 'PURCHASE_ORDER', steps: [{ name: 'Owner', approverId: users.approver.id }] })).id;
  await owner.must('post', '/api/procurement-workflows/delegations', { delegateUserId: users.manager.id, startDate: new Date(Date.now() + 86_400_000).toISOString(), endDate: new Date(Date.now() + 10 * 86_400_000).toISOString() });
  const po2 = await owner.must('post', '/api/purchases', { supplierId: ids.supplier, items: [{ productId: ids.product, quantity: 3, unitCost: 20 }] });
  ids.purchaseOrder2 = po2.id;
  await owner.must('post', `/api/purchases/${ids.purchaseOrder2}/submit`, {});
  // An approved order still to be received, with one receipt not yet received and one received but not inspected.
  const po3 = await owner.must('post', '/api/purchases', { supplierId: ids.supplier, items: [{ productId: ids.product, quantity: 10, unitCost: 20 }] });
  ids.purchaseOrder3 = po3.id;
  ids.purchaseOrder3Item = (po3.items as Array<{ id: string }>)[0].id;
  await owner.must('post', `/api/purchases/${ids.purchaseOrder3}/submit`, {});
  await approver.must('post', `/api/purchases/${ids.purchaseOrder3}/approve`, {});
  const grn2 = await owner.must('post', '/api/grn', { purchaseOrderId: ids.purchaseOrder3, supplierId: ids.supplier, warehouseId: ids.warehouse, lines: [{ purchaseOrderItemId: ids.purchaseOrder3Item, productId: ids.product, receivedQuantity: 2 }] });
  ids.goodsReceipt2 = grn2.id;
  ids.goodsReceipt2Line = (grn2.lines as Array<{ id: string }>)[0].id;
  const grn3 = await owner.must('post', '/api/grn', { purchaseOrderId: ids.purchaseOrder3, supplierId: ids.supplier, warehouseId: ids.warehouse, lines: [{ purchaseOrderItemId: ids.purchaseOrder3Item, productId: ids.product, receivedQuantity: 2 }] });
  ids.goodsReceipt3 = grn3.id;
  ids.goodsReceipt3Line = (grn3.lines as Array<{ id: string }>)[0].id;
  await owner.must('post', `/api/grn/${ids.goodsReceipt3}/receive`, { lines: [{ id: ids.goodsReceipt3Line, receivedQuantity: 2 }] });
  // A DRAFT order (the only state an order is edited in).
  ids.purchaseOrder4 = (await owner.must('post', '/api/purchases', { supplierId: ids.supplier, items: [{ productId: ids.product, quantity: 1, unitCost: 20 }] })).id;

  // Media, documents, imports, webhooks, invitations, notifications, search, reconciliation
  const media = await owner.call('post', `/api/media/upload/product/${ids.product}`).attach('file', PNG, { filename: `photo-${label}.png`, contentType: 'image/png' });
  if (media.status >= 300) throw new Error(`seed: media upload -> ${media.status} ${media.text}`);
  const variantMedia = await owner.call('post', `/api/media/upload/variant/${ids.variant}`).attach('file', PNG, { filename: `variant-${label}.png`, contentType: 'image/png' });
  if (variantMedia.status >= 300) throw new Error(`seed: variant media upload -> ${variantMedia.status} ${variantMedia.text}`);
  ids.mediaAsset = (await run.system(() => prisma.mediaAsset.findFirstOrThrow({ where: { shopId: shop.shopId } }))).id;
  ids.productMediaReference = (await run.system(() => prisma.mediaReference.findFirstOrThrow({ where: { shopId: shop.shopId, productId: ids.product } }))).id;
  ids.variantMediaReference = (await run.system(() => prisma.mediaReference.findFirstOrThrow({ where: { shopId: shop.shopId, variantId: ids.variant } }))).id;
  await owner.must('post', '/api/media/tag', { assetId: ids.mediaAsset, tag: `tag-${marker}` });
  await owner.must('post', '/api/storage/customers', { customerId: shop.customerId });
  const bills = await owner.call('post', `/api/storage/bills/${shop.customerId}/bill-${label}`).attach('image', PNG, { filename: 'bill.png', contentType: 'image/png' });
  if (bills.status >= 300) throw new Error(`seed: stored bill -> ${bills.status} ${bills.text}`);
  const stored = await owner.call('post', `/api/storage/invoices/${shop.customerId}/${ids.invoice}`).field('jsonContent', JSON.stringify({ note: marker })).attach('pdf', PDF, { filename: 'inv.pdf', contentType: 'application/pdf' });
  if (stored.status >= 300) throw new Error(`seed: stored invoice -> ${stored.status} ${stored.text}`);
  await owner.must('post', `/api/storage/payments/${shop.customerId}`, { paymentData: { amount: 40, note: marker } });
  const csv = ['sku,name,sellingPrice,costPrice', `IMP-${shop.suffix},Imported ${marker},100,60`].join('\n');
  const imported = await owner.call('post', '/api/imports/products/upload').field('mode', 'UPSERT').field('dryRun', 'true').attach('file', Buffer.from(csv), { filename: 'products.csv', contentType: 'text/csv' });
  if (imported.status >= 300) throw new Error(`seed: import -> ${imported.status} ${imported.text}`);
  ids.importJob = imported.body.jobId as string;
  ids.webhook = (await owner.must('post', '/api/webhooks', { url: `https://hooks-${label}.example.test/in`, events: ['*'] })).id;
  ids.invitation = (await owner.must('post', '/api/invitations/generate', { email: `invitee-${shop.suffix}@test.local`, role: 'CASHIER' })).id;
  ids.notification = (await owner.must('post', '/api/notifications', { type: 'LOW_STOCK', title: `Note ${marker}`, message: `body ${marker}` })).id;
  await owner.must('post', '/api/search/synonyms', { term: `syn${label}`, synonyms: `${marker} alias` });
  await owner.must('get', `/api/search?q=${encodeURIComponent(marker)}`);
  ids.reconciliationRun = (await owner.must('post', '/api/reconciliation/run', {})).id;

  return { shop, marker, users, tokens, ids, saleTotal: 100 * units };
}

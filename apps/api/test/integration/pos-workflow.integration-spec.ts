/**
 * EXEC-006C end-to-end business workflow against a real MySQL + Redis.
 *
 * Boots the full AppModule, then drives the POS through its services and
 * HTTP surface: shop → products → stock → shifts → sales (cash with change,
 * split, credit) → idempotency → 20-way concurrency → partial and full
 * returns → cancellation → customer repayment → dashboard/report reads, and
 * asserts every invariant the roadmap names (stock, ledger, customer
 * balance, shift, audit, outbox).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, TenderType } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantContextService } from '../../src/iam/tenant-context/tenant-context.service';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { InvoiceQueryService } from '../../src/billing/services/invoice-query.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { CustomersService } from '../../src/customers/customers.service';
import { InventoryDomainService } from '../../src/inventory-domain/services/inventory-domain.service';
import { InventoryLocationService } from '../../src/inventory-domain/services/inventory-location.service';
import { DashboardService } from '../../src/analytics-domain/services/dashboard.service';
import { AnalyticsPageService } from '../../src/analytics-domain/services/analytics-page.service';
import { ReportExportService } from '../../src/analytics-domain/services/report-export.service';
import { SearchEngineService } from '../../src/product-search/search-engine.service';
import { InvoiceMathEngine } from '@dukaanai/invoice-math';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { BillingActor } from '../../src/billing/billing.types';
import { randomUUID } from 'crypto';

jest.setTimeout(180_000);

const num = (v: Prisma.Decimal | number | string | null | undefined) => Number(v ?? 0);

describe('EXEC-006C POS workflow (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenant: TenantContextService;
  let billing: BillingService;
  let reversal: InvoiceReversalService;
  let queries: InvoiceQueryService;
  let shifts: ShiftsService;
  let customers: CustomersService;
  let inventoryDomain: InventoryDomainService;
  let locations: InventoryLocationService;
  let dashboard: DashboardService;
  let analyticsPage: AnalyticsPageService;
  let exporter: ReportExportService;
  let search: SearchEngineService;
  let jwt: JwtService;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let shopId: string;
  let ownerId: string;
  let cashierId: string;
  let customerId: string;
  let otherShopId: string;
  let otherProductId: string;
  const products: Record<string, string> = {};
  let saleLocationId: string;

  const actorFor = (userId: string, role: Role): BillingActor => ({ shopId, userId, role, ipAddress: '127.0.0.1', correlationId: `test-${randomUUID()}` });
  const ctxFor = (userId: string, role: Role) => ({ shopId, userId, role, correlationId: 'test', requestId: 'test' });
  // Prisma promises are lazy: the query runs on `await`, so the await must
  // happen INSIDE the AsyncLocalStorage scope for the tenant extension to see it.
  const asCashier = <T>(fn: () => Promise<T>) => tenant.runWithContext(ctxFor(cashierId, Role.CASHIER), async () => await fn());
  const asOwner = <T>(fn: () => Promise<T>) => tenant.runWithContext(ctxFor(ownerId, Role.OWNER), async () => await fn());
  const asSystem = <T>(fn: () => Promise<T>) => tenant.runAsSuperAdmin(async () => await fn());

  const onHand = async (productId: string) => {
    const item = await asSystem(() => prisma.inventoryItem.findFirst({ where: { shopId, productId, locationId: saleLocationId } }));
    return item ? num(item.onHand) : null;
  };
  const productStock = async (productId: string) => num((await asSystem(() => prisma.product.findUniqueOrThrow({ where: { id: productId } }))).currentStock);
  const ledgerBalance = async (account: 'CASH' | 'BANK' | 'ACCOUNTS_RECEIVABLE' | 'SALES_REVENUE' | 'GST_PAYABLE' | 'INVENTORY' | 'COST_OF_GOODS') => {
    const row = await asSystem(() => prisma.ledgerAccountBalance.findUnique({ where: { shopId_account: { shopId, account } } }));
    return row ? num(row.balance) : 0;
  };
  const outstanding = async () => num((await asSystem(() => prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))).outstandingBalance);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tenant = app.get(TenantContextService);
    billing = app.get(BillingService);
    reversal = app.get(InvoiceReversalService);
    queries = app.get(InvoiceQueryService);
    shifts = app.get(ShiftsService);
    customers = app.get(CustomersService);
    inventoryDomain = app.get(InventoryDomainService);
    locations = app.get(InventoryLocationService);
    dashboard = app.get(DashboardService);
    analyticsPage = app.get(AnalyticsPageService);
    exporter = app.get(ReportExportService);
    search = app.get(SearchEngineService);
    jwt = app.get(JwtService);

    await asSystem(async () => {
      const shop = await prisma.shop.create({ data: { name: `Shop ${suffix}`, state: 'Karnataka', city: 'Bengaluru' } });
      shopId = shop.id;
      await prisma.shopSettings.create({ data: { shopId, timezone: 'Asia/Kolkata', gstin: '29ABCDE1234F1Z5' } });
      const owner = await prisma.user.create({ data: { email: `owner-${suffix}@test.local`, name: 'Owner', role: 'OWNER', password: 'x', shopId } });
      ownerId = owner.id;
      await prisma.shop.update({ where: { id: shopId }, data: { ownerId } });
      const cashier = await prisma.user.create({ data: { email: `cashier-${suffix}@test.local`, name: 'Cashier', role: 'CASHIER', password: 'x', shopId } });
      cashierId = cashier.id;

      const customer = await prisma.customer.create({ data: { name: 'Ravi', phone: `9${suffix.slice(-9)}`, shopId, state: 'Karnataka', creditLimit: 500 } });
      customerId = customer.id;

      const mk = (key: string, data: Partial<Prisma.ProductUncheckedCreateInput>) =>
        prisma.product.create({
          data: {
            name: `${key} ${suffix}`,
            sku: `${key}-${suffix}`,
            barcode: `${key}${suffix}`,
            costPrice: 60,
            sellingPrice: 100,
            mrp: 120,
            wholesalePrice: 90,
            unit: 'PCS',
            gstRate: 'EIGHTEEN',
            shopId,
            ...data,
          },
        });
      products.tea = (await mk('TEA', {})).id;
      products.rice = (await mk('RICE', { unit: 'KG', gstRate: 'FIVE', sellingPrice: 80, costPrice: 50 })).id;
      products.soap = (await mk('SOAP', { gstRate: 'TWELVE', sellingPrice: 45.5, costPrice: 30 })).id;
      products.legacy = (await mk('LEGACY', { currentStock: 5 })).id;
      products.hot = (await mk('HOT', {})).id;
      products.service = (await mk('SERVICE', { type: 'SERVICE', sellingPrice: 200, costPrice: 0 })).id;

      const other = await prisma.shop.create({ data: { name: `Other ${suffix}`, state: 'Kerala' } });
      otherShopId = other.id;
      const otherOwner = await prisma.user.create({ data: { email: `other-${suffix}@test.local`, name: 'Other', role: 'OWNER', password: 'x', shopId: otherShopId } });
      await prisma.shop.update({ where: { id: otherShopId }, data: { ownerId: otherOwner.id } });
      otherProductId = (
        await prisma.product.create({ data: { name: 'Foreign', sku: `F-${suffix}`, costPrice: 1, sellingPrice: 2, mrp: 2, wholesalePrice: 2, unit: 'PCS', shopId: otherShopId } })
      ).id;
    });

    // Receive stock through the inventory domain (the same engine the POS deducts from).
    await asOwner(async () => {
      saleLocationId = await locations.resolveSaleLocation(prisma, shopId);
      for (const [key, qtyIn] of [['tea', 50], ['rice', 20], ['soap', 30], ['hot', 10]] as const) {
        const item = await inventoryDomain.ensureInventoryItem(products[key]);
        await inventoryDomain.adjustStock(item.id, 'OPENING_BALANCE', qtyIn, ownerId, { notes: 'opening' });
      }
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('stock received through the engine lands where the POS sells from', async () => {
    expect(await onHand(products.tea)).toBe(50);
    expect(await productStock(products.tea)).toBe(50);
    const ledger = await asSystem(() => prisma.stockLedgerEntry.findMany({ where: { shopId, inventoryItem: { productId: products.tea } } }));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].movementType).toBe('OPENING_BALANCE');
  });

  it('opens a shift for the cashier', async () => {
    const shift = await asCashier(() => shifts.open({ openingCash: 1000 }, actorFor(cashierId, Role.CASHIER)));
    expect(shift.status).toBe('OPEN');
    expect(num(shift.expectedCash)).toBe(1000);
    await expect(asCashier(() => shifts.open({ openingCash: 1 }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({ response: { code: 'SHIFT_ALREADY_OPEN' } });
  });

  let cashInvoiceId: string;

  it('cash sale with change: invoice, lines, tenders, stock, ledger, shift, audit and outbox all agree', async () => {
    const cashBefore = await ledgerBalance('CASH');
    const revenueBefore = await ledgerBalance('SALES_REVENUE');
    const gstBefore = await ledgerBalance('GST_PAYABLE');

    const expected = InvoiceMathEngine.calculate({
      items: [
        { productId: products.tea, quantity: 2, unitPrice: 100, gstRateStr: 'EIGHTEEN', isInterState: false },
        { productId: products.rice, quantity: 1.5, unitPrice: 80, gstRateStr: 'FIVE', isInterState: false },
      ],
    });
    const total = expected.finalTotal.toNumber();

    const result = await asCashier(() =>
      billing.createInvoice(
        {
          idempotencyKey: randomUUID(),
          items: [
            { productId: products.tea, quantity: 2 },
            { productId: products.rice, quantity: 1.5 },
          ],
          payments: [{ tender: TenderType.CASH, amount: total, tenderedAmount: 500 }],
        },
        actorFor(cashierId, Role.CASHIER),
      ),
    );
    cashInvoiceId = result.invoice.id;

    expect(result.replayed).toBe(false);
    expect(result.invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
    expect(result.invoice.status).toBe('COMPLETED');
    expect(num(result.invoice.totalAmount)).toBe(total);
    expect(num(result.invoice.subtotal)).toBe(320);
    expect(num(result.invoice.taxAmount)).toBe(expected.totalTax.toNumber());
    expect(num(result.invoice.roundOffAmount)).toBe(expected.roundOff.toNumber());
    expect(num(result.invoice.paidAmount)).toBe(total);
    expect(num(result.invoice.changeAmount)).toBe(Number((500 - total).toFixed(2)));
    expect(result.invoice.paymentMode).toBe('CASH');
    expect(result.invoice.payments).toHaveLength(1);
    expect(num(result.invoice.payments[0].changeAmount)).toBe(Number((500 - total).toFixed(2)));
    expect(result.invoice.items.map((i) => num(i.taxableAmount))).toEqual(expected.lines.map((l) => l.taxableAmount.toNumber()));
    expect(result.shiftId).toBeTruthy();

    // Stock
    expect(await onHand(products.tea)).toBe(48);
    expect(await onHand(products.rice)).toBe(18.5);
    expect(await productStock(products.tea)).toBe(48);
    expect(result.stock.find((s) => s.productId === products.tea)?.balanceAfter).toBe(48);
    const logs = await asSystem(() => prisma.inventoryLog.findMany({ where: { invoiceId: cashInvoiceId } }));
    expect(logs).toHaveLength(2);

    // Ledger: balanced, running balances moved by exactly the invoice amounts
    const entries = await asSystem(() => prisma.ledgerTransaction.findMany({ where: { invoiceId: cashInvoiceId } }));
    const debits = entries.filter((e) => e.type === 'DEBIT').reduce((a, e) => a + num(e.amount), 0);
    const credits = entries.filter((e) => e.type === 'CREDIT').reduce((a, e) => a + num(e.amount), 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect((await ledgerBalance('CASH')) - cashBefore).toBeCloseTo(total, 2);
    expect((await ledgerBalance('SALES_REVENUE')) - revenueBefore).toBeCloseTo(expected.taxableTotal.plus(expected.roundOff).toNumber(), 2);
    expect((await ledgerBalance('GST_PAYABLE')) - gstBefore).toBeCloseTo(expected.totalTax.toNumber(), 2);

    // Shift
    const shift = await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)));
    expect(num(shift!.cashSales)).toBeCloseTo(total, 2);
    expect(num(shift!.expectedCash)).toBeCloseTo(1000 + total, 2);

    // Audit + outbox
    const audit = await asSystem(() => prisma.auditLog.findFirst({ where: { entity: 'Invoice', entityId: cashInvoiceId, action: 'INVOICE_CREATED' } }));
    expect(audit?.userId).toBe(cashierId);
    const outbox = await asSystem(() => prisma.outboxEvent.findFirst({ where: { entityId: cashInvoiceId, type: 'INVOICE_CREATED' } }));
    expect(outbox?.shopId).toBe(shopId);
    expect((outbox?.payload as { items: unknown[] }).items).toHaveLength(2);

    // Receipt payload
    const receipt = await asCashier(() => queries.receipt(cashInvoiceId, actorFor(cashierId, Role.CASHIER)));
    expect(receipt.shop.gstin).toBe('29ABCDE1234F1Z5');
    expect(receipt.gstSummary.map((g) => g.rate).sort()).toEqual(['EIGHTEEN', 'FIVE']);
    expect(num(receipt.totals.grandTotal)).toBe(total);
  });

  it('service products never touch stock', async () => {
    const result = await asCashier(() =>
      billing.createInvoice(
        { idempotencyKey: randomUUID(), items: [{ productId: products.service, quantity: 1 }], payments: [{ tender: TenderType.UPI, amount: 236, reference: 'UPI-1' }] },
        actorFor(cashierId, Role.CASHIER),
      ),
    );
    expect(result.stock).toHaveLength(0);
    expect(result.invoice.paymentMode).toBe('UPI');
    expect(await asSystem(() => prisma.inventoryItem.findFirst({ where: { shopId, productId: products.service } }))).toBeNull();
  });

  it('legacy products with only Product.currentStock are bootstrapped into the ledger on first sale', async () => {
    expect(await onHand(products.legacy)).toBeNull();
    await asCashier(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.legacy, quantity: 2 }], payments: [{ tender: TenderType.CASH, amount: 236 }] }, actorFor(cashierId, Role.CASHIER)),
    );
    expect(await onHand(products.legacy)).toBe(3);
    expect(await productStock(products.legacy)).toBe(3);
    const opening = await asSystem(() => prisma.stockLedgerEntry.findFirst({ where: { shopId, movementType: 'OPENING_BALANCE', inventoryItem: { productId: products.legacy } } }));
    expect(num(opening?.quantity)).toBe(5);
  });

  it('idempotent replay returns the same invoice; reuse with a different payload is rejected', async () => {
    const key = randomUUID();
    const dto = { idempotencyKey: key, items: [{ productId: products.soap, quantity: 1 }], payments: [{ tender: TenderType.CARD, amount: 51 }] };
    const first = await asCashier(() => billing.createInvoice(dto, actorFor(cashierId, Role.CASHIER)));
    const second = await asCashier(() => billing.createInvoice(dto, actorFor(cashierId, Role.CASHIER)));
    expect(second.replayed).toBe(true);
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(await asSystem(() => prisma.invoice.count({ where: { shopId, idempotencyKey: key } }))).toBe(1);
    expect(await onHand(products.soap)).toBe(29);

    await expect(
      asCashier(() => billing.createInvoice({ ...dto, items: [{ productId: products.soap, quantity: 2 }], payments: [{ tender: TenderType.CARD, amount: 102 }] }, actorFor(cashierId, Role.CASHIER))),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('rejects mismatched payments, duplicate lines, unknown/foreign products and missing customer for credit', async () => {
    const actor = actorFor(cashierId, Role.CASHIER);
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 100 }] }, actor))).rejects.toMatchObject({
      response: { code: 'ERR_PAYMENT_MISMATCH' },
    });
    await expect(
      asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1, discountPercent: 5 }, { productId: products.tea, quantity: 1 }], payments: [] }, actor)),
    ).rejects.toMatchObject({ response: { code: 'ERR_DUPLICATE_LINE' } });
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: otherProductId, quantity: 1 }], payments: [] }, actor))).rejects.toMatchObject({
      response: { code: 'PRODUCT_NOT_FOUND' },
    });
    await expect(asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [], udharAmount: 118 }, actor))).rejects.toMatchObject({
      response: { code: 'CUSTOMER_REQUIRED' },
    });
    expect(await onHand(products.tea)).toBe(48);
  });

  let creditInvoiceId: string;

  it('credit sale moves the customer balance; the credit limit is enforced for cashiers and overridable by managers', async () => {
    const arBefore = await ledgerBalance('ACCOUNTS_RECEIVABLE');
    const result = await asCashier(() =>
      billing.createInvoice(
        { idempotencyKey: randomUUID(), customerId, items: [{ productId: products.tea, quantity: 3 }], payments: [{ tender: TenderType.CASH, amount: 154 }], udharAmount: 200 },
        actorFor(cashierId, Role.CASHIER),
      ),
    );
    creditInvoiceId = result.invoice.id;
    expect(result.invoice.paymentMode).toBe('SPLIT');
    expect(await outstanding()).toBe(200);
    expect((await ledgerBalance('ACCOUNTS_RECEIVABLE')) - arBefore).toBeCloseTo(200, 2);
    const udhar = await asSystem(() => prisma.udharTransaction.findFirst({ where: { invoiceId: creditInvoiceId } }));
    expect(udhar?.type).toBe('CREDIT');
    expect(num(udhar?.balanceAfter)).toBe(200);

    // 200 outstanding + 354 > 500 limit → cashier blocked, nothing written
    const teaBefore = await onHand(products.tea);
    await expect(
      asCashier(() => billing.createInvoice({ idempotencyKey: randomUUID(), customerId, items: [{ productId: products.tea, quantity: 3 }], payments: [], udharAmount: 354 }, actorFor(cashierId, Role.CASHIER))),
    ).rejects.toMatchObject({ response: { code: 'CREDIT_LIMIT_EXCEEDED' } });
    expect(await onHand(products.tea)).toBe(teaBefore);
    expect(await outstanding()).toBe(200);
    const rejected = await asSystem(() => prisma.auditLog.findFirst({ where: { shopId, action: 'INVOICE_REJECTED', entityId: 'CREDIT_LIMIT_EXCEEDED' } }));
    expect(rejected).toBeTruthy();

    // Manager override
    const override = await asOwner(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), customerId, items: [{ productId: products.tea, quantity: 1 }], payments: [], udharAmount: 118 }, actorFor(ownerId, Role.OWNER)),
    );
    expect(override.invoice.paymentMode).toBe('UDHAR');
    expect(await outstanding()).toBe(318);
  });

  it('20 concurrent sales against 10 units: exactly 10 succeed, stock ends at 0, never negative', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        tenant.runWithContext(ctxFor(i % 2 ? cashierId : ownerId, i % 2 ? Role.CASHIER : Role.OWNER), () =>
          billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.hot, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 118 }] }, actorFor(i % 2 ? cashierId : ownerId, i % 2 ? Role.CASHIER : Role.OWNER)),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const f of failed) expect((f.reason as { response?: { code?: string } }).response?.code).toBe('INSUFFICIENT_STOCK');

    expect(await onHand(products.hot)).toBe(0);
    expect(await productStock(products.hot)).toBe(0);
    const sales = await asSystem(() => prisma.stockLedgerEntry.count({ where: { shopId, movementType: 'SALE', inventoryItem: { productId: products.hot } } }));
    expect(sales).toBe(10);
    const numbers = ok.map((r) => (r as PromiseFulfilledResult<{ invoice: { invoiceNumber: string } }>).value.invoice.invoiceNumber);
    expect(new Set(numbers).size).toBe(10);
  });

  it('partial then full return restores stock, reverses ledger/credit and blocks over-return', async () => {
    const original = await asCashier(() => queries.get(creditInvoiceId, actorFor(cashierId, Role.CASHIER)));
    const line = original.items[0];
    const teaBefore = await onHand(products.tea);
    const revenueBefore = await ledgerBalance('SALES_REVENUE');
    const outstandingBefore = await outstanding();

    const partial = await asCashier(() =>
      reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: creditInvoiceId, items: [{ invoiceItemId: line.id, quantity: 1 }], reason: 'DAMAGED' as never, refund: { tender: TenderType.CASH } }, actorFor(cashierId, Role.CASHIER)),
    );
    expect(partial.invoice.type).toBe('SALES_RETURN');
    expect(partial.invoice.invoiceNumber).toMatch(/^RET-/);
    expect(num(partial.invoice.totalAmount)).toBe(118);
    // The 118 refund reverses unpaid credit first (customer still owes 318), so no cash leaves the drawer.
    expect(num(partial.invoice.udharAmount)).toBe(118);
    expect(num(partial.invoice.paidAmount)).toBe(0);
    expect(await outstanding()).toBe(outstandingBefore - 118);
    expect(await onHand(products.tea)).toBe(teaBefore! + 1);
    expect((await ledgerBalance('SALES_REVENUE')) - revenueBefore).toBeCloseTo(-100, 2);

    const afterPartial = await asCashier(() => queries.get(creditInvoiceId, actorFor(cashierId, Role.CASHIER)));
    expect(num(afterPartial.items[0].returnedQuantity)).toBe(1);
    expect(afterPartial.returns).toHaveLength(1);

    const rest = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: creditInvoiceId }, actorFor(cashierId, Role.CASHIER)));
    expect(num(rest.invoice.items[0].quantity)).toBe(2);
    expect(await onHand(products.tea)).toBe(teaBefore! + 3);

    await expect(asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: creditInvoiceId }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({
      response: { code: 'INVOICE_NOT_RETURNABLE' },
    });
    await expect(asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: partial.invoice.id }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({
      response: { code: 'INVOICE_NOT_RETURNABLE' },
    });
  });

  it('cancelling a same-day cash invoice reverses stock, ledger and drawer and keeps the number', async () => {
    const shiftBefore = await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)));
    const teaBefore = await onHand(products.tea);
    const cashBefore = await ledgerBalance('CASH');
    const original = await asCashier(() => queries.get(cashInvoiceId, actorFor(cashierId, Role.CASHIER)));

    await expect(asCashier(() => reversal.cancelInvoice(cashInvoiceId, { reason: 'wrong bill' }, actorFor(cashierId, Role.CASHIER)))).resolves.toBeTruthy();
    const cancelled = await asCashier(() => queries.get(cashInvoiceId, actorFor(cashierId, Role.CASHIER)));
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.invoiceNumber).toBe(original.invoiceNumber);
    expect(cancelled.cancelledById).toBe(cashierId);
    expect(await onHand(products.tea)).toBe(teaBefore! + 2);
    expect(cashBefore - (await ledgerBalance('CASH'))).toBeCloseTo(num(original.totalAmount), 2);
    const shiftAfter = await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)));
    expect(num(shiftBefore!.expectedCash) - num(shiftAfter!.expectedCash)).toBeCloseTo(num(original.totalAmount), 2);

    await expect(asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: cashInvoiceId }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({
      response: { code: 'INVOICE_NOT_RETURNABLE' },
    });
  });

  it('customer repayment is locked, ledgered, idempotent and refuses overpayment unless allowed', async () => {
    const before = await outstanding();
    expect(before).toBeGreaterThan(0);
    const arBefore = await ledgerBalance('ACCOUNTS_RECEIVABLE');
    const shiftBefore = await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)));

    const key = randomUUID();
    const dto = { idempotencyKey: key, amount: 100, tender: TenderType.CASH };
    const first = await asCashier(() => customers.recordPayment(customerId, dto, actorFor(cashierId, Role.CASHIER)));
    expect(num(first.customer.outstandingBalance)).toBe(before - 100);
    expect(first.transaction.type).toBe('PAYMENT');
    const replay = await asCashier(() => customers.recordPayment(customerId, dto, actorFor(cashierId, Role.CASHIER)));
    expect(replay.replayed).toBe(true);
    expect(await outstanding()).toBe(before - 100);
    expect(arBefore - (await ledgerBalance('ACCOUNTS_RECEIVABLE'))).toBeCloseTo(100, 2);
    const shiftAfter = await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)));
    expect(num(shiftAfter!.totalReceipts) - num(shiftBefore!.totalReceipts)).toBe(100);
    expect(num(shiftAfter!.expectedCash) - num(shiftBefore!.expectedCash)).toBe(100);

    await expect(asCashier(() => customers.recordPayment(customerId, { idempotencyKey: randomUUID(), amount: 100000, tender: TenderType.UPI }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({
      response: { code: 'PAYMENT_EXCEEDS_OUTSTANDING' },
    });

    // Balance invariant against the udhar ledger
    const txns = await asSystem(() => prisma.udharTransaction.findMany({ where: { customerId } }));
    const derived = txns.reduce((acc, t) => (t.type === 'CREDIT' ? acc + num(t.amount) : acc - num(t.amount)), 0);
    expect(await outstanding()).toBeCloseTo(derived, 2);
  });

  it('closing the shift reports the variance and blocks further cash refunds', async () => {
    const closed = await asCashier(() => shifts.close({ closingCash: 999 }, actorFor(cashierId, Role.CASHIER)));
    expect(closed.status).toBe('CLOSED');
    expect(num(closed.variance)).toBeCloseTo(999 - num(closed.expectedCash), 2);
    expect(await asCashier(() => shifts.current(actorFor(cashierId, Role.CASHIER)))).toBeNull();

    const sale = await asCashier(() =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId: products.soap, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 51 }] }, actorFor(cashierId, Role.CASHIER)),
    );
    expect(sale.shiftId).toBeNull();
    await expect(asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: sale.invoice.id, refund: { tender: TenderType.CASH } }, actorFor(cashierId, Role.CASHIER)))).rejects.toMatchObject({
      response: { code: 'SHIFT_REQUIRED' },
    });
    const upiRefund = await asCashier(() => reversal.processReturn({ idempotencyKey: randomUUID(), invoiceId: sale.invoice.id, refund: { tender: TenderType.UPI, reference: 'REF-1' } }, actorFor(cashierId, Role.CASHIER)));
    expect(upiRefund.invoice.payments[0].tender).toBe('UPI');
  });

  it('dashboard, analytics, invoice history and CSV exports reconcile with the invoice table', async () => {
    const [sales, returns] = await asSystem(() =>
      Promise.all([
        prisma.invoice.aggregate({ where: { shopId, type: 'SALE', status: 'COMPLETED', isDeleted: false }, _sum: { totalAmount: true }, _count: { _all: true } }),
        prisma.invoice.aggregate({ where: { shopId, type: 'SALES_RETURN', status: 'COMPLETED', isDeleted: false }, _sum: { totalAmount: true } }),
      ]),
    );
    const net = num(sales._sum.totalAmount) - num(returns._sum.totalAmount);

    const summary = await asOwner(() => dashboard.getSummary(shopId, ownerId));
    expect(summary.totalRevenue).toBeCloseTo(net, 2);
    expect(summary.todaySales).toBeCloseTo(net, 2);
    expect(summary.todayOrders).toBe(sales._count._all);
    expect(summary.outstandingUdhar).toBeCloseTo(await outstanding(), 2);
    expect(summary.recentInvoices.every((i) => i.status !== 'CANCELLED')).toBe(true);
    expect(summary.paymentModes.reduce((a, m) => a + m.amount, 0)).toBeGreaterThan(0);

    const kpis = await asOwner(() => dashboard.getKpis(shopId));
    expect(kpis.netRevenue).toBeCloseTo(net, 2);

    const page = await asOwner(() => analyticsPage.getAnalytics(shopId, 'today'));
    expect(page.kpis.totalRevenue).toBeCloseTo(net, 2);

    const list = await asOwner(() => queries.list({ take: 100 }, actorFor(ownerId, Role.OWNER)));
    expect(list.total).toBe(await asSystem(() => prisma.invoice.count({ where: { shopId, isDeleted: false } })));
    const cancelledRow = list.items.find((i) => i.id === cashInvoiceId);
    expect(cancelledRow?.status).toBe('CANCELLED');

    // The CSV export carries the same population as the dashboards: COMPLETED
    // sales and returns only (cancelled and draft rows are excluded), so a
    // total summed from the file equals the dashboard net revenue.
    const range = await asOwner(() => exporter.resolveRange(shopId));
    let csv = '';
    await asOwner(() => exporter.streamInvoicesCsv(shopId, range, (chunk) => { csv += chunk; }));
    const rows = csv.trim().split('\n');
    expect(rows[0]).toContain('invoiceNumber');
    expect(rows.length - 1).toBe(sales._count._all + (await asSystem(() => prisma.invoice.count({ where: { shopId, type: 'SALES_RETURN', status: 'COMPLETED', isDeleted: false } }))));
    const header = rows[0].split(',');
    const typeIdx = header.indexOf('type');
    const totalIdx = header.indexOf('totalAmount');
    const csvNet = rows.slice(1).reduce((acc, row) => {
      const cols = row.split(',');
      return acc + (cols[typeIdx] === 'SALE' ? 1 : -1) * Number(cols[totalIdx]);
    }, 0);
    expect(csvNet).toBeCloseTo(net, 2);
    let gst = '';
    await asOwner(() => exporter.streamGstSummaryCsv(shopId, range, (chunk) => { gst += chunk; }));
    expect(gst).toContain('gstRate');
  });

  it('search finds products by name, SKU and barcode and never leaks other shops', async () => {
    const byName = await asOwner(() => search.search(shopId, 'TEA'));
    expect(byName.some((p) => p.id === products.tea)).toBe(true);
    expect(byName.some((p) => p.id === otherProductId)).toBe(false);
    const bySku = await asOwner(() => search.search(shopId, `RICE-${suffix}`));
    expect(bySku[0]?.id).toBe(products.rice);
    const scanned = await asOwner(() => search.findByBarcode(shopId, `SOAP${suffix}`));
    expect(scanned.id).toBe(products.soap);
    expect(scanned.currentStock).toBe(await productStock(products.soap));
    await expect(asOwner(() => search.findByBarcode(shopId, 'does-not-exist'))).rejects.toMatchObject({ response: { code: 'BARCODE_NOT_FOUND' } });
    const special = await asOwner(() => search.search(shopId, 'te+a -"x" (y)'));
    expect(Array.isArray(special)).toBe(true);
  });

  it('HTTP surface: validation, error envelope with code, tenant scoping and a real checkout', async () => {
    const token = jwt.sign({ sub: cashierId, email: `cashier-${suffix}@test.local`, role: 'CASHIER', shopId, tokenVersion: 0 });
    const server = app.getHttpServer();

    const bad = await request(server).post('/api/billing/invoice').set('Authorization', `Bearer ${token}`).send({ items: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.correlationId).toBeTruthy();

    const foreign = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ productId: otherProductId, quantity: 1 }], payments: [] });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('PRODUCT_NOT_FOUND');

    const preview = await request(server)
      .post('/api/billing/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: products.tea, quantity: 1 }], customerId });
    expect(preview.status).toBe(200);
    expect(preview.body.payment).toBeNull();
    expect(preview.body.isInterState).toBe(false);

    const ok = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ productId: products.tea, quantity: 1 }], payments: [{ tender: 'CASH', amount: 118, tenderedAmount: 200 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.invoice.invoiceNumber).toMatch(/^INV-/);
    expect(Number(ok.body.invoice.changeAmount)).toBe(82);

    const short = await request(server)
      .post('/api/billing/invoice')
      .set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: randomUUID(), items: [{ productId: products.hot, quantity: 1 }], payments: [{ tender: 'CASH', amount: 118 }] });
    expect(short.status).toBe(409);
    expect(short.body.code).toBe('INSUFFICIENT_STOCK');
    expect(short.body.details.availableQty).toBe(0);

    const unauthorised = await request(server).get('/api/billing/invoices');
    expect(unauthorised.status).toBe(401);

    const cancelAsCashier = await request(server).post(`/api/billing/invoices/${ok.body.invoice.id}/cancel`).set('Authorization', `Bearer ${token}`).send({ reason: 'x' });
    expect(cancelAsCashier.status).toBe(403);

    const receipt = await request(server).get(`/api/billing/invoices/${ok.body.invoice.id}/receipt`).set('Authorization', `Bearer ${token}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.shop.name).toContain('Shop');

    const csv = await request(server).get('/api/dashboard/export/invoices.csv').set('Authorization', `Bearer ${jwt.sign({ sub: ownerId, email: 'o', role: 'OWNER', shopId, tokenVersion: 0 })}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });

  it('every stock movement is explained by the ledger and Product.currentStock equals the sum of locations', async () => {
    const items = await asSystem(() => prisma.inventoryItem.findMany({ where: { shopId, isDeleted: false }, include: { stockLedgerEntries: true, product: true } }));
    for (const item of items) {
      const ledgerSum = item.stockLedgerEntries.reduce((a, e) => a + num(e.quantity), 0);
      expect(num(item.onHand)).toBeCloseTo(ledgerSum, 3);
      const siblings = items.filter((i) => i.productId === item.productId).reduce((a, i) => a + num(i.onHand), 0);
      expect(num(item.product.currentStock)).toBeCloseTo(siblings, 3);
      expect(num(item.onHand)).toBeGreaterThanOrEqual(0);
    }
    const balances = await asSystem(() => prisma.ledgerAccountBalance.findMany({ where: { shopId } }));
    const txns = await asSystem(() => prisma.ledgerTransaction.findMany({ where: { shopId } }));
    const debit = txns.filter((t) => t.type === 'DEBIT').reduce((a, t) => a + num(t.amount), 0);
    const credit = txns.filter((t) => t.type === 'CREDIT').reduce((a, t) => a + num(t.amount), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(balances.length).toBeGreaterThan(0);
  });
});

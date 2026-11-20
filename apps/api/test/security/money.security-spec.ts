/**
 * Money integrity (audit P1-1, P1-2): refunds can never exceed the sale, and
 * the ledger keeps accepting postings once an account passes 10 crore.
 * Both were fixed by roadmap 3.1 / 3.2; see README.md.
 */
import { INestApplication } from '@nestjs/common';
import { Role, TenderType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../../src/billing/billing.service';
import { InvoiceReversalService } from '../../src/billing/services/invoice-reversal.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShiftsService } from '../../src/shifts/shifts.service';
import { actorFor, bootApp, createProduct, createShop, makeReaders, num, receiveStock, tenantRunner, TestShop } from '../integration/pos-fixtures';

describe('security: money integrity', () => {
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

  /** A shop whose cashier has an open shift, so cash sales and refunds are allowed. */
  const shopWithOpenShift = async (label: string): Promise<TestShop> => {
    const shop = await createShop(app, label);
    await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () => shifts.open({ openingCash: 1000 }, actorFor(shop, shop.cashierId, Role.CASHIER)));
    return shop;
  };

  it('P1-1: four one-unit returns of a 4 x 0.50 sale refund exactly the 2.00 that was paid', async () => {
    const shop = await shopWithOpenShift('refund');
    const actor = actorFor(shop, shop.cashierId, Role.CASHIER);
    const productId = await createProduct(app, shop, { key: 'half', sellingPrice: 0.5, gstRate: 'ZERO' });
    await receiveStock(app, shop, productId, 4);
    const readers = makeReaders(app, shop);
    const cashBefore = await readers.ledgerBalance('CASH');

    const sale = await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
      billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity: 4 }], payments: [{ tender: TenderType.CASH, amount: 2 }] }, actor),
    );
    expect(num(sale.invoice.totalAmount)).toBe(2);
    const line = await run.system(() => prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: sale.invoice.id } }));

    let refunded = 0;
    for (let i = 0; i < 4; i++) {
      const result = await run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
        reversal.processReturn(
          { idempotencyKey: randomUUID(), invoiceId: sale.invoice.id, items: [{ invoiceItemId: line.id, quantity: 1 }], reason: 'DAMAGED' as never, refund: { tender: TenderType.CASH } },
          actor,
        ),
      );
      refunded += num(result.invoice.totalAmount);
    }

    expect(refunded).toBe(2);
    expect(await readers.ledgerBalance('CASH')).toBe(cashBefore);
  });

  it('P1-2: a sale still posts when the CASH account already holds 9,99,99,950', async () => {
    const shop = await shopWithOpenShift('ledger');
    const actor = actorFor(shop, shop.cashierId, Role.CASHIER);
    const productId = await createProduct(app, shop, { key: 'big', sellingPrice: 100, gstRate: 'ZERO' });
    await receiveStock(app, shop, productId, 1);
    await run.system(() =>
      prisma.ledgerAccountBalance.upsert({
        where: { shopId_account: { shopId: shop.shopId, account: 'CASH' } },
        create: { shopId: shop.shopId, account: 'CASH', balance: 99_999_950 },
        update: { balance: 99_999_950 },
      }),
    );

    await expect(
      run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
        billing.createInvoice({ idempotencyKey: randomUUID(), items: [{ productId, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 100 }] }, actor),
      ),
    ).resolves.toBeDefined();

    expect(await makeReaders(app, shop).ledgerBalance('CASH')).toBe(100_000_050);
  });

  it('3.2 boundary: a customer whose lifetime purchases pass 9,99,99,999 can still be billed and keeps exact totals', async () => {
    const shop = await shopWithOpenShift('totals');
    const actor = actorFor(shop, shop.cashierId, Role.CASHIER);
    const productId = await createProduct(app, shop, { key: 'big', sellingPrice: 100, gstRate: 'ZERO' });
    await receiveStock(app, shop, productId, 1);
    await run.system(() => prisma.customer.update({ where: { id: shop.customerId }, data: { totalPurchases: 99_999_999, totalPaid: 99_999_999 } }));

    await expect(
      run.as(shop.shopId, shop.cashierId, Role.CASHIER, () =>
        billing.createInvoice({ idempotencyKey: randomUUID(), customerId: shop.customerId, items: [{ productId, quantity: 1 }], payments: [{ tender: TenderType.CASH, amount: 100 }] }, actor),
      ),
    ).resolves.toBeDefined();
    const customer = await run.system(() => prisma.customer.findUniqueOrThrow({ where: { id: shop.customerId } }));
    expect(num(customer.totalPurchases)).toBe(100_000_099);
  });
});

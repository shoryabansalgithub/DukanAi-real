import { Prisma, Role } from '@prisma/client';
import { StreamableFile } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { canSeeFinancials, isFinancialField, withoutFinancialFields } from './financial-fields';
import { FinancialFieldsInterceptor } from './financial-fields.interceptor';

describe('financial fields (release audit 2026-10-12)', () => {
  it('names cost, profit, margin, payables and stock valuation, and nothing a cashier bills with', () => {
    for (const key of ['costPrice', 'unitCost', 'totalCost', 'oldCostPrice', 'grossProfit', 'netProfit', 'todayProfit', 'profitChangePct', 'grossMarginPct', 'cogs', 'totalCogs', 'pendingPayables', 'openingPayables', 'outstandingPayables', 'totalPayables', 'inventoryValue', 'stockValue']) {
      expect([key, isFinancialField(key)]).toEqual([key, true]);
    }
    for (const key of ['sellingPrice', 'mrp', 'wholesalePrice', 'totalAmount', 'taxableAmount', 'discountAmount', 'cgstAmount', 'currentStock', 'balance', 'creditLimit', 'totalPurchases', 'cashPayouts', 'expectedCash', 'paidAmount', 'todaySales', 'totalRevenue', 'outstandingUdhar']) {
      expect([key, isFinancialField(key)]).toEqual([key, false]);
    }
  });

  it('only FINANCE_ROLES see them', () => {
    expect([Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER].map(canSeeFinancials)).toEqual([true, true, true, true]);
    expect([Role.CASHIER, Role.VIEWER, undefined, null, 'cashier'].map(canSeeFinancials)).toEqual([false, false, false, false, false]);
  });

  it('removes the keys at any depth and keeps everything else, without touching the input', () => {
    const createdAt = new Date('2026-10-12T05:00:00.000Z');
    const product = {
      id: 'p1',
      name: 'Tea',
      sellingPrice: new Prisma.Decimal('20.00'),
      costPrice: new Prisma.Decimal('12.50'),
      createdAt,
      variants: [{ id: 'v1', costPrice: '11.00', mrp: '25.00' }],
      supplier: { id: 's1', name: 'Wholesaler', pendingPayables: '900.00' },
      revision: { snapshot: { costPrice: 12, newCostPrice: 13, name: 'Tea' } },
      tags: ['a', 'b'],
      empty: null,
    };
    const before = JSON.stringify(product);
    const out = withoutFinancialFields({ items: [product], total: 1 });

    expect(JSON.parse(JSON.stringify(out))).toEqual({
      items: [{
        id: 'p1',
        name: 'Tea',
        sellingPrice: '20',
        createdAt: '2026-10-12T05:00:00.000Z',
        variants: [{ id: 'v1', mrp: '25.00' }],
        supplier: { id: 's1', name: 'Wholesaler' },
        revision: { snapshot: { name: 'Tea' } },
        tags: ['a', 'b'],
        empty: null,
      }],
      total: 1,
    });
    // Same serialisation as the original for what is kept; the input is unchanged.
    expect(JSON.stringify(product)).toBe(before);
    expect(product.costPrice.toString()).toBe('12.5');
  });

  it('passes primitives, buffers and streamed files through untouched', () => {
    const file = new StreamableFile(Buffer.from('x'));
    const bytes = Buffer.from('costPrice');
    expect(withoutFinancialFields(file)).toBe(file);
    expect(withoutFinancialFields(bytes)).toBe(bytes);
    expect(withoutFinancialFields('costPrice')).toBe('costPrice');
    expect(withoutFinancialFields(42)).toBe(42);
    expect(withoutFinancialFields(undefined)).toBeUndefined();
  });

  describe('FinancialFieldsInterceptor', () => {
    const interceptor = new FinancialFieldsInterceptor();
    const contextFor = (role?: Role): ExecutionContext =>
      ({
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
      }) as unknown as ExecutionContext;
    const body = { id: 'p1', sellingPrice: 20, costPrice: 12 };
    const handler: CallHandler = { handle: () => of(body) };
    const run = (role?: Role) => lastValueFrom(interceptor.intercept(contextFor(role), handler) as never);

    it('answers a manager with the body as it is', async () => {
      await expect(run(Role.MANAGER)).resolves.toBe(body);
      await expect(run(Role.OWNER)).resolves.toBe(body);
    });

    it('answers a cashier, a stock clerk and an anonymous caller without the cost', async () => {
      for (const role of [Role.CASHIER, Role.VIEWER, undefined]) {
        await expect(run(role)).resolves.toEqual({ id: 'p1', sellingPrice: 20 });
      }
    });

    it('leaves non-HTTP contexts alone', async () => {
      const ws = { getType: () => 'ws' } as unknown as ExecutionContext;
      await expect(lastValueFrom(interceptor.intercept(ws, handler) as never)).resolves.toBe(body);
    });
  });
});

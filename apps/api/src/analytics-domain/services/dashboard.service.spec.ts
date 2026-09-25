import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DashboardService, MAX_LOW_STOCK_ITEMS, SUMMARY_SECTIONS } from './dashboard.service';

const D = (value: number | string) => new Prisma.Decimal(value);

function setup() {
  const totals = (gross: number, returns: number, orders: number, returnCount = 0) => ({
    grossSales: D(gross),
    returns: D(returns),
    netSales: D(gross - returns),
    orders,
    returnCount,
  });
  const revenueEngine = {
    totals: jest.fn((_shop: string, start?: Date) => Promise.resolve(start ? totals(1000, 100, 4, 1) : totals(5000, 300, 20, 2))),
    profit: jest.fn().mockResolvedValue(D(250)),
    paymentModeBuckets: jest.fn().mockResolvedValue([{ mode: 'CASH', amount: D(700) }, { mode: 'UPI', amount: D(200) }]),
  };
  // $queryRaw is used by lowStock (counts, then items) and inventoryValue; answer by SQL text.
  const queryRaw = jest.fn((strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    const sql = strings.join('?');
    if (sql.includes('AS lowStock')) return Promise.resolve([{ lowStock: 2n, outOfStock: 1n }]);
    if (sql.includes('SELECT p.id, p.name')) {
      return Promise.resolve([
        { id: 'p-out', name: 'Out', sku: 'OUT', unit: 'PCS', currentStock: D(0), reorderPoint: D(5) },
        { id: 'p-low', name: 'Low', sku: 'LOW', unit: 'KG', currentStock: D('1.5'), reorderPoint: D(4) },
      ]);
    }
    if (sql.includes('AS value')) return Promise.resolve([{ value: D('1234.5') }]);
    return Promise.resolve([]);
  });
  const prisma = {
    $queryRaw: queryRaw,
    customer: {
      count: jest.fn().mockResolvedValue(3),
      aggregate: jest.fn().mockResolvedValue({ _sum: { outstandingBalance: D(84) } }),
    },
    product: { count: jest.fn().mockResolvedValue(9) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    shift: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const cache = { getKpis: jest.fn().mockResolvedValue(null), setKpis: jest.fn().mockResolvedValue(undefined) };
  const shopTimezone = { resolve: jest.fn().mockResolvedValue('Asia/Kolkata') };
  const service = new DashboardService(
    prisma as never,
    revenueEngine as never,
    {} as never,
    {} as never,
    cache as never,
    shopTimezone as never,
  );
  return { service, prisma, revenueEngine, cache, queryRaw };
}

describe('DashboardService', () => {
  it('returns every section with no failures when all reads succeed', async () => {
    const { service, revenueEngine } = setup();
    const s = await service.getSummary('shop-1', 'user-1');

    expect(s.failedSections).toEqual([]);
    expect(s).toMatchObject({
      todayGrossSales: 1000,
      todayReturns: 100,
      todaySales: 900,
      todayOrders: 4,
      todayReturnCount: 1,
      todayProfit: 250,
      totalRevenue: 4700,
      totalOrders: 20,
      totalCustomers: 3,
      totalProducts: 9,
      outstandingUdhar: 84,
      lowStockCount: 2,
      outOfStockCount: 1,
      inventoryValue: 1234.5,
      paymentModes: [{ mode: 'CASH', amount: 700 }, { mode: 'UPI', amount: 200 }],
    });
    expect(s.lowStockItems).toEqual([
      { productId: 'p-out', name: 'Out', sku: 'OUT', unit: 'PCS', currentStock: 0, reorderPoint: 5, status: 'OUT_OF_STOCK' },
      { productId: 'p-low', name: 'Low', sku: 'LOW', unit: 'KG', currentStock: 1.5, reorderPoint: 4, status: 'LOW_STOCK' },
    ]);
    // Payment modes are requested net of refunds so they reconcile with net sales.
    expect(revenueEngine.paymentModeBuckets).toHaveBeenCalledWith('shop-1', expect.any(Date), expect.any(Date), { netOfRefunds: true });
  });

  it('isolates a failing section: its figures are null, the rest stay authoritative', async () => {
    const { service, revenueEngine, prisma } = setup();
    revenueEngine.profit.mockRejectedValueOnce(new Error('profit query failed'));
    prisma.invoice.findMany.mockRejectedValueOnce(new Error('recent query failed'));

    const s = await service.getSummary('shop-1', 'user-1');

    expect(s.failedSections).toEqual(['todayProfit', 'recentInvoices']);
    expect(s.todayProfit).toBeNull();
    expect(s.recentInvoices).toEqual([]);
    expect(s.todaySales).toBe(900);
    expect(s.inventoryValue).toBe(1234.5);
    expect(s.lowStockCount).toBe(2);
  });

  it('reports the stock section as one unit (counts and list) when its query fails', async () => {
    const { service, queryRaw } = setup();
    queryRaw.mockImplementation((strings: TemplateStringsArray): Promise<unknown[]> => {
      const sql = strings.join('?');
      if (sql.includes('AS lowStock')) return Promise.reject(new Error('stock query failed'));
      if (sql.includes('AS value')) return Promise.resolve([{ value: D(10) }]);
      return Promise.resolve([]);
    });

    const s = await service.getSummary('shop-1', 'user-1');
    expect(s.failedSections).toEqual(['stock']);
    expect(s.lowStockCount).toBeNull();
    expect(s.outOfStockCount).toBeNull();
    expect(s.lowStockItems).toEqual([]);
    expect(s.inventoryValue).toBe(10);
  });

  it('answers 503 DASHBOARD_UNAVAILABLE only when every section fails', async () => {
    const { service, revenueEngine, prisma, queryRaw } = setup();
    const boom = () => Promise.reject(new Error('db down'));
    revenueEngine.totals.mockImplementation(boom);
    revenueEngine.profit.mockImplementation(boom);
    revenueEngine.paymentModeBuckets.mockImplementation(boom);
    queryRaw.mockImplementation(boom);
    prisma.customer.count.mockImplementation(boom);
    prisma.customer.aggregate.mockImplementation(boom);
    prisma.product.count.mockImplementation(boom);
    prisma.invoice.findMany.mockImplementation(boom);
    prisma.shift.findFirst.mockImplementation(boom);

    await expect(service.getSummary('shop-1', 'user-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(SUMMARY_SECTIONS).toHaveLength(11);
  });

  it('computes the average order value on net sales and caches the KPIs', async () => {
    const { service, cache } = setup();
    const k = await service.getKpis('shop-1');
    expect(k).toMatchObject({ grossRevenue: 1000, totalRefunds: 100, netRevenue: 900, orders: 4, avgOrderValue: 225 });
    expect(cache.setKpis).toHaveBeenCalledWith('shop-1', k);

    cache.getKpis.mockResolvedValueOnce({ cached: true });
    await expect(service.getKpis('shop-1')).resolves.toEqual({ cached: true });
  });

  it('clamps the low-stock limit and skips the item query for a zero limit', async () => {
    const { service, queryRaw } = setup();
    await service.lowStock('shop-1', 10_000);
    const itemCall = queryRaw.mock.calls.find((call) => (call[0] as unknown as string[]).join('?').includes('SELECT p.id, p.name'));
    const limitArg = (itemCall as unknown[]).slice(1).find((arg) => (arg as { sql?: string } | null)?.sql === String(MAX_LOW_STOCK_ITEMS));
    expect(limitArg).toBeDefined();

    queryRaw.mockClear();
    const none = await service.lowStock('shop-1', 0);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(none).toEqual({ lowStockCount: 2, outOfStockCount: 1, items: [] });
  });
});

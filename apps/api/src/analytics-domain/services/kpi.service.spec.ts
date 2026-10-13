import { Prisma } from '@prisma/client';
import { KpiService } from './kpi.service';

const D = (value: number | string) => new Prisma.Decimal(value);

/** Release audit (KPI writer): one multi-row upsert per 500 products, never one round trip per product. */
describe('KpiService.calculateDailyKpis', () => {
  function setup(productCount: number) {
    const products = Array.from({ length: productCount }, (_, i) => ({ id: `p${String(i).padStart(5, '0')}`, costPrice: D(10) }));
    const executed: Array<{ sql: string; values: unknown[] }> = [];
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
      inventoryItem: { groupBy: jest.fn().mockResolvedValue([{ productId: 'p00000', _sum: { onHand: D(30) } }]) },
      $queryRaw: jest.fn().mockResolvedValue([{ productId: 'p00000', units: D(60) }]),
      $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        executed.push({ sql: strings.join('?'), values });
        return Promise.resolve(0);
      }),
      inventoryKpi: { upsert: jest.fn() },
    };
    const service = new KpiService(prisma as never, { resolve: jest.fn().mockResolvedValue('Asia/Kolkata') } as never);
    return { service, prisma, executed };
  }

  it('writes every product in batched INSERT ... ON DUPLICATE KEY UPDATE statements', async () => {
    const { service, prisma, executed } = setup(1201);
    // 2026-10-11 20:00 UTC is already 10-12 in Kolkata: the row is keyed by the shop's business date.
    await expect(service.calculateDailyKpis('shop-1', new Date('2026-10-11T20:00:00Z'))).resolves.toBe(1201);
    expect(prisma.inventoryKpi.upsert).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    for (const { sql } of executed) {
      expect(sql).toContain('INSERT INTO InventoryKpi');
      expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    }
    const flat = JSON.stringify(executed.map((e) => e.values));
    expect(flat).toContain('2026-10-12');
    // The sold product: 60 units over 30 days with 30 on hand = 15 days of cover, value 300 at cost.
    expect(flat).toContain('300.0000');
    expect(flat).toContain('15.00');
  });

  it('writes nothing for a shop without products', async () => {
    const { service, prisma } = setup(0);
    await expect(service.calculateDailyKpis('shop-1')).resolves.toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

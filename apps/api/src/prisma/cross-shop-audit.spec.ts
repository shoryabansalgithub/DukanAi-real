import { Prisma } from '@prisma/client';
import { auditCrossShopReferences, crossShopChecks, RawQueryClient, shopPathOf } from './cross-shop-audit';
import { tenantAuditCommand, TENANT_AUDIT_USAGE } from '../cli/tenant-audit';
import { CliUsageError, runCli } from '../cli/run-cli';

/** Models with no way to a shop at all, each with its reason: a new one fails here until it is given a shop or a reason. */
const NO_SHOP_PATH: Record<string, string> = {
  IdempotencyRecord: 'a generic key table with no relation; nothing in src/ reads or writes it',
};

describe('cross-shop audit (cross-shop isolation audit, 2026-10-12)', () => {
  it('reads a shop path for every model: its own shopId, the Shop row, or its parent, through the joins that lead there', () => {
    expect(shopPathOf('Product', 'm')).toEqual({ joins: [], expr: 'm.`shopId`' });
    expect(shopPathOf('Shop', 'm')).toEqual({ joins: [], expr: 'm.`id`' });
    expect(shopPathOf('InvoiceItem', 'm')).toEqual({ joins: ['JOIN `Invoice` m_0 ON m_0.`id` = m.`invoiceId`'], expr: 'm_0.`shopId`', via: 'invoice' });
    const unscoped = Prisma.dmmf.datamodel.models.filter((m) => shopPathOf(m.name, 'm') === null).map((m) => m.name);
    expect(unscoped.sort()).toEqual(Object.keys(NO_SHOP_PATH).sort());
  });

  it('checks every relation between two models that belong to shops, except the one that defines a child row’s shop', () => {
    const checks = crossShopChecks();
    const keys = checks.map((c) => `${c.model}.${c.field}`);
    expect(checks.length).toBeGreaterThan(150);
    expect(keys).toEqual(expect.arrayContaining(['InvoiceItem.product', 'Invoice.customer', 'GoodsReceiptLine.purchaseOrderItem', 'Invoice.cashier', 'Batch.product']));
    // InvoiceItem's shop is its invoice's: that relation is the path, not a check.
    expect(keys).not.toContain('InvoiceItem.invoice');
    expect(keys).not.toContain('WebhookDelivery.endpoint');
    // A link to the Shop row is where a path ends.
    expect(checks.some((c) => c.target === 'Shop')).toBe(false);
    const invoiceItemProduct = checks.find((c) => c.model === 'InvoiceItem' && c.field === 'product')!;
    expect(invoiceItemProduct.fromWhere).toBe(
      'FROM `InvoiceItem` m JOIN `Invoice` m_0 ON m_0.`id` = m.`invoiceId` JOIN `Product` r ON r.`id` = m.`productId` WHERE m_0.`shopId` <> r.`shopId`',
    );
  });

  it('reports each relation that joins two shops with its row count and a sample, and narrows to given shops on request', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db: RawQueryClient = {
      $queryRawUnsafe: (async (sql: string, ...values: unknown[]) => {
        queries.push({ sql, values });
        const crossing = sql.includes('FROM `Batch` m JOIN `Product` r');
        if (sql.startsWith('SELECT COUNT(*)')) return [{ n: crossing ? 2n : 0n }];
        return [{ id: 'b1', ownShop: 's1', targetShop: 's2' }];
      }) as RawQueryClient['$queryRawUnsafe'],
    };
    const all = await auditCrossShopReferences(db);
    expect(all.checked).toBe(crossShopChecks().length);
    expect(all.findings).toEqual([{ model: 'Batch', field: 'product', target: 'Product', rows: 2, sample: [{ id: 'b1', ownShop: 's1', targetShop: 's2' }] }]);
    expect(queries.every((q) => q.values.length === 0)).toBe(true);

    queries.length = 0;
    await auditCrossShopReferences(db, { shops: ['s1', 's2'] });
    expect(queries.every((q) => q.sql.includes('IN (?, ?)') && q.values.join() === 's1,s2,s1,s2')).toBe(true);
  });

  describe('node dist/cli/tenant-audit', () => {
    const run = async (argv: string[], findings: Awaited<ReturnType<typeof auditCrossShopReferences>>['findings'] = []) => {
      const lines: string[] = [];
      const disconnect = jest.fn(async () => undefined);
      const code = await runCli(
        tenantAuditCommand({ connect: () => ({ $disconnect: disconnect }) as never, audit: async () => ({ checked: 214, findings }), out: (l) => lines.push(l) }),
        argv,
      );
      return { code, lines, disconnect };
    };

    it('answers 0 and CLEAN when no relation crosses shops, and always disconnects', async () => {
      const { code, lines, disconnect } = await run([]);
      expect(code).toBe(0);
      expect(lines).toEqual(['Relations checked: 214', 'CLEAN: no row of one shop names a row of another.']);
      expect(disconnect).toHaveBeenCalled();
    });

    it('answers 1 with every crossing relation, and JSON on --json', async () => {
      const finding = { model: 'Batch', field: 'product', target: 'Product', rows: 1, sample: [{ id: 'b1', ownShop: 's1', targetShop: 's2' }] };
      const text = await run([], [finding]);
      expect(text.code).toBe(1);
      expect(text.lines[1]).toBe('CROSS-SHOP Batch.product -> Product: 1 row(s), e.g. [{"id":"b1","ownShop":"s1","targetShop":"s2"}]');
      const json = await run(['--json'], [finding]);
      expect([json.code, JSON.parse(json.lines[0])]).toEqual([1, { checked: 214, findings: [finding] }]);
    });

    it('prints its usage on --help and refuses without DATABASE_URL (exit 2)', async () => {
      expect((await run(['--help'])).lines).toEqual([TENANT_AUDIT_USAGE]);
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await runCli(tenantAuditCommand({ out: () => undefined }), [])).toBe(2);
        expect(errors).toHaveBeenCalledWith('error: DATABASE_URL is not set');
      } finally {
        errors.mockRestore();
        if (saved !== undefined) process.env.DATABASE_URL = saved;
      }
      expect(new CliUsageError('x')).toBeInstanceOf(Error);
    });
  });
});

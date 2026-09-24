import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { GrnIntegrationService } from './grn-integration.service';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('GrnIntegrationService', () => {
  let service: GrnIntegrationService;
  let engine: { mutateStock: jest.Mock };
  let locations: { resolveWarehouseBin: jest.Mock };
  let ledger: { post: jest.Mock };
  let tx: Record<string, never>;

  const mutationResult = (bypassed: boolean) => ({
    bypassed,
    balanceAfter: D(0),
    availableAfter: D(0),
    productStockAfter: D(0),
  });

  beforeEach(() => {
    engine = { mutateStock: jest.fn().mockResolvedValue(mutationResult(false)) };
    locations = { resolveWarehouseBin: jest.fn().mockResolvedValue('loc-1') };
    ledger = { post: jest.fn().mockResolvedValue({ posted: true, postingId: 'lp-1' }) };
    tx = {};
    service = new GrnIntegrationService(
      engine as unknown as InventoryMutationEngine,
      locations as unknown as InventoryLocationService,
      ledger as unknown as LedgerPostingService,
    );
  });

  const run = (lines: Array<{ productId: string; acceptedQuantity: Prisma.Decimal; unitPrice: Prisma.Decimal }>) =>
    service.updateInventoryFromGrn(tx as unknown as Prisma.TransactionClient, 'shop-1', {
      id: 'grn-1',
      warehouseId: 'wh-1',
      createdBy: 'user-1',
      lines,
    });

  it('mutates stock per accepted line and posts DEBIT INVENTORY / CREDIT ACCOUNTS_PAYABLE for the received value', async () => {
    await run([
      { productId: 'p-1', acceptedQuantity: D('3'), unitPrice: D('10.50') },
      { productId: 'p-2', acceptedQuantity: D('1.5'), unitPrice: D('7.33') },
      { productId: 'p-3', acceptedQuantity: D('0'), unitPrice: D('99') },
    ]);

    expect(locations.resolveWarehouseBin).toHaveBeenCalledWith(tx, 'shop-1', 'wh-1');
    expect(engine.mutateStock).toHaveBeenCalledTimes(2);
    expect(engine.mutateStock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        shopId: 'shop-1',
        locationId: 'loc-1',
        productId: 'p-1',
        quantity: 3,
        mutationType: MutationType.PURCHASE,
        referenceId: 'grn-1',
        idempotencyKey: 'GRN:grn-1:p-1',
      }),
    );

    // 3 × 10.50 + 1.5 × 7.33 = 31.50 + 10.995 → 42.50 (2 dp, round half up)
    expect(ledger.post).toHaveBeenCalledTimes(1);
    const [postTx, posting] = ledger.post.mock.calls[0];
    expect(postTx).toBe(tx);
    expect(posting.shopId).toBe('shop-1');
    expect(posting.invoiceId).toBeNull();
    expect(posting.description).toBe('GRN grn-1');
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries[0].account).toBe(LedgerAccount.INVENTORY);
    expect(posting.entries[0].type).toBe(LedgerEntryType.DEBIT);
    expect(posting.entries[0].amount.toFixed(2)).toBe('42.50');
    expect(posting.entries[1].account).toBe(LedgerAccount.ACCOUNTS_PAYABLE);
    expect(posting.entries[1].type).toBe(LedgerEntryType.CREDIT);
    expect(posting.entries[1].amount.toFixed(2)).toBe('42.50');
    expect(posting.source).toEqual({ type: 'GRN', id: 'grn-1' });
  });

  it('excludes lines the engine bypassed (SERVICE / DIGITAL) from the inventory value', async () => {
    engine.mutateStock
      .mockResolvedValueOnce(mutationResult(false))
      .mockResolvedValueOnce(mutationResult(true));

    await run([
      { productId: 'p-stocked', acceptedQuantity: D('2'), unitPrice: D('25') },
      { productId: 'p-service', acceptedQuantity: D('4'), unitPrice: D('1000') },
    ]);

    expect(engine.mutateStock).toHaveBeenCalledTimes(2);
    expect(ledger.post).toHaveBeenCalledTimes(1);
    const posting = ledger.post.mock.calls[0][1];
    expect(posting.entries.map((e: { amount: Prisma.Decimal }) => e.amount.toFixed(2))).toEqual(['50.00', '50.00']);
  });

  it('skips the posting when the received value is zero', async () => {
    await run([
      { productId: 'p-free', acceptedQuantity: D('5'), unitPrice: D('0') },
      { productId: 'p-none', acceptedQuantity: D('0'), unitPrice: D('10') },
    ]);

    expect(engine.mutateStock).toHaveBeenCalledTimes(1);
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('delegates replay protection to the ledger source key (a re-accepted GRN posts nothing twice)', async () => {
    ledger.post.mockResolvedValue({ posted: false, postingId: 'lp-existing' });

    await expect(run([{ productId: 'p-1', acceptedQuantity: D('3'), unitPrice: D('10') }])).resolves.toBeUndefined();

    expect(engine.mutateStock).toHaveBeenCalledTimes(1);
    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(ledger.post.mock.calls[0][1].source).toEqual({ type: 'GRN', id: 'grn-1' });
  });
});

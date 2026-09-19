import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { PurchaseReturnInventoryService } from './purchase-return-inventory.service';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { InventoryLocationService } from '../../inventory-domain/services/inventory-location.service';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('PurchaseReturnInventoryService', () => {
  let service: PurchaseReturnInventoryService;
  let engine: { mutateStock: jest.Mock };
  let locations: { resolveWarehouseBin: jest.Mock };
  let ledger: { post: jest.Mock };
  let tx: { ledgerTransaction: { findFirst: jest.Mock } };

  const mutationResult = (bypassed: boolean) => ({
    bypassed,
    balanceAfter: D(0),
    availableAfter: D(0),
    productStockAfter: D(0),
  });

  beforeEach(() => {
    engine = { mutateStock: jest.fn().mockResolvedValue(mutationResult(false)) };
    locations = { resolveWarehouseBin: jest.fn().mockResolvedValue('loc-1') };
    ledger = { post: jest.fn().mockResolvedValue(undefined) };
    tx = { ledgerTransaction: { findFirst: jest.fn().mockResolvedValue(null) } };
    service = new PurchaseReturnInventoryService(
      engine as unknown as InventoryMutationEngine,
      locations as unknown as InventoryLocationService,
      ledger as unknown as LedgerPostingService,
    );
  });

  const run = (lines: Array<{ productId: string; returnQuantity: Prisma.Decimal; unitPrice: Prisma.Decimal }>) =>
    service.processInventoryReversal(tx as unknown as Prisma.TransactionClient, 'shop-1', {
      id: 'pr-1',
      warehouseId: null,
      createdBy: null,
      lines,
    });

  it('mutates stock per returned line and posts DEBIT ACCOUNTS_PAYABLE / CREDIT INVENTORY for the returned value', async () => {
    await run([
      { productId: 'p-1', returnQuantity: D('2'), unitPrice: D('12.25') },
      { productId: 'p-2', returnQuantity: D('0.5'), unitPrice: D('3.01') },
    ]);

    expect(locations.resolveWarehouseBin).toHaveBeenCalledWith(tx, 'shop-1', null);
    expect(engine.mutateStock).toHaveBeenCalledTimes(2);
    expect(engine.mutateStock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        shopId: 'shop-1',
        locationId: 'loc-1',
        productId: 'p-1',
        quantity: 2,
        mutationType: MutationType.PURCHASE_RETURN,
        referenceId: 'pr-1',
        performedBy: 'SYSTEM',
        idempotencyKey: 'PRET:pr-1:p-1',
      }),
    );

    // 2 × 12.25 + 0.5 × 3.01 = 24.50 + 1.505 → 26.01 (2 dp, round half up)
    expect(ledger.post).toHaveBeenCalledTimes(1);
    const [postTx, posting] = ledger.post.mock.calls[0];
    expect(postTx).toBe(tx);
    expect(posting.shopId).toBe('shop-1');
    expect(posting.invoiceId).toBeNull();
    expect(posting.description).toBe('Purchase return pr-1');
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries[0].account).toBe(LedgerAccount.ACCOUNTS_PAYABLE);
    expect(posting.entries[0].type).toBe(LedgerEntryType.DEBIT);
    expect(posting.entries[0].amount.toFixed(2)).toBe('26.01');
    expect(posting.entries[1].account).toBe(LedgerAccount.INVENTORY);
    expect(posting.entries[1].type).toBe(LedgerEntryType.CREDIT);
    expect(posting.entries[1].amount.toFixed(2)).toBe('26.01');
    expect(tx.ledgerTransaction.findFirst).toHaveBeenCalledWith({
      where: { shopId: 'shop-1', description: 'Purchase return pr-1' },
      select: { id: true },
    });
  });

  it('excludes lines the engine bypassed (SERVICE / DIGITAL) from the returned value', async () => {
    engine.mutateStock
      .mockResolvedValueOnce(mutationResult(true))
      .mockResolvedValueOnce(mutationResult(false));

    await run([
      { productId: 'p-digital', returnQuantity: D('9'), unitPrice: D('500') },
      { productId: 'p-stocked', returnQuantity: D('3'), unitPrice: D('4') },
    ]);

    expect(ledger.post).toHaveBeenCalledTimes(1);
    const posting = ledger.post.mock.calls[0][1];
    expect(posting.entries.map((e: { amount: Prisma.Decimal }) => e.amount.toFixed(2))).toEqual(['12.00', '12.00']);
  });

  it('skips the posting when the returned value is zero', async () => {
    await run([{ productId: 'p-free', returnQuantity: D('5'), unitPrice: D('0') }]);

    expect(engine.mutateStock).toHaveBeenCalledTimes(1);
    expect(tx.ledgerTransaction.findFirst).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('skips the posting when a ledger transaction for the return already exists (retry)', async () => {
    tx.ledgerTransaction.findFirst.mockResolvedValue({ id: 'lt-1' });

    await run([{ productId: 'p-1', returnQuantity: D('1'), unitPrice: D('10') }]);

    expect(engine.mutateStock).toHaveBeenCalledTimes(1);
    expect(ledger.post).not.toHaveBeenCalled();
  });
});

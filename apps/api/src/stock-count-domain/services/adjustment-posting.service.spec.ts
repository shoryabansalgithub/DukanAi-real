import { BadRequestException } from '@nestjs/common';
import { AdjustmentStatus, LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { AdjustmentPostingService } from './adjustment-posting.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryMutationEngine, MutationType } from '../../inventory-domain/services/inventory-mutation.engine';
import { LedgerPostingService } from '../../ledger/ledger-posting.service';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('AdjustmentPostingService', () => {
  let service: AdjustmentPostingService;
  let engine: { mutateStock: jest.Mock };
  let ledger: { post: jest.Mock };
  let tx: {
    product: { findUnique: jest.Mock };
    adjustmentRequest: { update: jest.Mock };
  };
  let prisma: { adjustmentRequest: { findFirst: jest.Mock }; $transaction: jest.Mock };

  const mutationResult = (bypassed: boolean) => ({
    bypassed,
    balanceAfter: D(0),
    availableAfter: D(0),
    productStockAfter: D(0),
  });

  const adjustment = (delta: string) => ({
    id: 'adj-1',
    shopId: 'shop-1',
    status: AdjustmentStatus.APPROVED,
    requestedQuantityDelta: D(delta),
    inventoryItem: { id: 'ii-1', productId: 'p-1', locationId: 'loc-1', isNegativeAllowed: false },
  });

  beforeEach(() => {
    engine = { mutateStock: jest.fn().mockResolvedValue(mutationResult(false)) };
    ledger = { post: jest.fn().mockResolvedValue({ posted: true, postingId: 'lp-1' }) };
    tx = {
      product: { findUnique: jest.fn().mockResolvedValue({ costPrice: D('12.50') }) },
      adjustmentRequest: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      adjustmentRequest: { findFirst: jest.fn() },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    service = new AdjustmentPostingService(
      prisma as unknown as PrismaService,
      engine as unknown as InventoryMutationEngine,
      ledger as unknown as LedgerPostingService,
    );
  });

  it('rejects an adjustment that is not approved', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(null);
    await expect(service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1')).rejects.toThrow(BadRequestException);
    expect(engine.mutateStock).not.toHaveBeenCalled();
  });

  it('positive delta: mutates stock in, posts DEBIT INVENTORY / CREDIT INVENTORY_ADJUSTMENT at cost, marks POSTED', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(adjustment('4'));

    await expect(service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1')).resolves.toEqual({ success: true });

    expect(engine.mutateStock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        shopId: 'shop-1',
        locationId: 'loc-1',
        productId: 'p-1',
        quantity: 4,
        mutationType: MutationType.ADJUSTMENT,
        metadata: { direction: 1 },
        referenceId: 'adj-1',
        performedBy: 'user-1',
        allowNegative: false,
      }),
    );
    expect(tx.product.findUnique).toHaveBeenCalledWith({ where: { id: 'p-1' }, select: { costPrice: true } });

    expect(ledger.post).toHaveBeenCalledTimes(1);
    const [postTx, posting] = ledger.post.mock.calls[0];
    expect(postTx).toBe(tx);
    expect(posting.shopId).toBe('shop-1');
    expect(posting.invoiceId).toBeNull();
    expect(posting.description).toBe('Stock adjustment adj-1');
    expect(posting.source).toEqual({ type: 'ADJUSTMENT_REQUEST', id: 'adj-1' });
    expect(posting.entries).toEqual([
      { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: expect.anything() },
      { account: LedgerAccount.INVENTORY_ADJUSTMENT, type: LedgerEntryType.CREDIT, amount: expect.anything() },
    ]);
    // 4 × 12.50 = 50.00
    expect(posting.entries.map((e: { amount: Prisma.Decimal }) => e.amount.toFixed(2))).toEqual(['50.00', '50.00']);

    expect(tx.adjustmentRequest.update).toHaveBeenCalledWith({
      where: { id: 'adj-1' },
      data: { status: AdjustmentStatus.POSTED },
    });
  });

  it('negative delta: mutates stock out and posts DEBIT INVENTORY_ADJUSTMENT / CREDIT INVENTORY', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(adjustment('-2.5'));

    await service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1');

    expect(engine.mutateStock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ quantity: 2.5, metadata: { direction: -1 } }),
    );
    const posting = ledger.post.mock.calls[0][1];
    // 2.5 × 12.50 = 31.25
    expect(posting.entries[0]).toMatchObject({ account: LedgerAccount.INVENTORY, type: LedgerEntryType.CREDIT });
    expect(posting.entries[0].amount.toFixed(2)).toBe('31.25');
    expect(posting.entries[1]).toMatchObject({ account: LedgerAccount.INVENTORY_ADJUSTMENT, type: LedgerEntryType.DEBIT });
    expect(posting.entries[1].amount.toFixed(2)).toBe('31.25');
  });

  it('posts nothing when the engine bypassed the product (SERVICE / DIGITAL)', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(adjustment('3'));
    engine.mutateStock.mockResolvedValue(mutationResult(true));

    await service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1');

    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
    expect(tx.adjustmentRequest.update).toHaveBeenCalled();
  });

  it('skips the posting when the value is zero (zero cost price)', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(adjustment('3'));
    tx.product.findUnique.mockResolvedValue({ costPrice: D('0') });

    await service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1');

    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('delegates replay protection to the ledger source key (keyed by the adjustment request id)', async () => {
    prisma.adjustmentRequest.findFirst.mockResolvedValue(adjustment('3'));
    ledger.post.mockResolvedValue({ posted: false, postingId: 'lp-existing' });

    await expect(service.postApprovedAdjustment('shop-1', 'adj-1', 'user-1')).resolves.toEqual({ success: true });

    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(ledger.post.mock.calls[0][1].source).toEqual({ type: 'ADJUSTMENT_REQUEST', id: 'adj-1' });
  });
});

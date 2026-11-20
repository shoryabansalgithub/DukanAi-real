import { LedgerAccount, LedgerEntryType, Prisma } from '@prisma/client';
import { LedgerPosting, LedgerPostingService } from './ledger-posting.service';

const posting = (overrides: Partial<LedgerPosting> = {}): LedgerPosting => ({
  shopId: 'shop-1',
  source: { type: 'GRN', id: 'grn-1' },
  description: 'GRN grn-1',
  entries: [
    { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: '42.50' },
    { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.CREDIT, amount: '42.50' },
  ],
  ...overrides,
});

function fakeTx(existing: { id: string } | null = null) {
  return {
    ledgerPosting: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue({ id: 'lp-new' }),
    },
    ledgerTransaction: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('LedgerPostingService', () => {
  const service = new LedgerPostingService();

  it('writes a header keyed by the business source and links every entry to it', async () => {
    const tx = fakeTx();
    await expect(service.post(tx as unknown as Prisma.TransactionClient, posting())).resolves.toEqual({ posted: true, postingId: 'lp-new' });

    expect(tx.ledgerPosting.findUnique).toHaveBeenCalledWith({
      where: { shopId_sourceType_sourceId: { shopId: 'shop-1', sourceType: 'GRN', sourceId: 'grn-1' } },
      select: { id: true },
    });
    expect(tx.ledgerPosting.create).toHaveBeenCalledWith({
      data: { shopId: 'shop-1', sourceType: 'GRN', sourceId: 'grn-1', description: 'GRN grn-1' },
      select: { id: true },
    });
    expect(tx.ledgerTransaction.create).toHaveBeenCalledTimes(2);
    for (const [call] of tx.ledgerTransaction.create.mock.calls) expect(call.data.postingId).toBe('lp-new');
  });

  it('is a no-op for a source that was already posted (replay)', async () => {
    const tx = fakeTx({ id: 'lp-old' });
    await expect(service.post(tx as unknown as Prisma.TransactionClient, posting())).resolves.toEqual({ posted: false, postingId: 'lp-old' });
    expect(tx.ledgerPosting.create).not.toHaveBeenCalled();
    expect(tx.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('lets the unique index reject a concurrent duplicate before any entry is written', async () => {
    const tx = fakeTx();
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'LedgerPosting_shopId_sourceType_sourceId_key' },
    });
    tx.ledgerPosting.create.mockRejectedValue(duplicate);
    await expect(service.post(tx as unknown as Prisma.TransactionClient, posting())).rejects.toBe(duplicate);
    expect(tx.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects an unbalanced posting before writing anything', async () => {
    const tx = fakeTx();
    const unbalanced = posting({
      entries: [
        { account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: '10' },
        { account: LedgerAccount.ACCOUNTS_PAYABLE, type: LedgerEntryType.CREDIT, amount: '9.99' },
      ],
    });
    await expect(service.post(tx as unknown as Prisma.TransactionClient, unbalanced)).rejects.toThrow('Unbalanced ledger posting');
    expect(tx.ledgerPosting.create).not.toHaveBeenCalled();
  });

  it('posts nothing (and writes no header) when every amount is zero', async () => {
    const tx = fakeTx();
    const zero = posting({ entries: [{ account: LedgerAccount.INVENTORY, type: LedgerEntryType.DEBIT, amount: 0 }] });
    await expect(service.post(tx as unknown as Prisma.TransactionClient, zero)).resolves.toEqual({ posted: false, postingId: null });
    expect(tx.ledgerPosting.findUnique).not.toHaveBeenCalled();
  });
});

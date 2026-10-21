import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../common/time/clock';
import { ShiftsService } from './shifts.service';

/**
 * `ShiftsService.open` under contention (roadmap 8.3). The database decides
 * who opens: a deadlock victim reruns and answers like everyone else, a lost
 * race on the unique key answers 409, a free slot opens. The deadlock is the
 * one CI met on MySQL 8 with eight concurrent opens of one cashier.
 */
describe('ShiftsService.open under contention', () => {
  const actor = { shopId: 'shop-1', userId: 'cashier-1', role: 'CASHIER' } as never;
  const created = {
    id: 'shift-9',
    openingCash: new Prisma.Decimal(10),
    expectedCash: new Prisma.Decimal(10),
    closingCash: null,
    openedBy: { id: 'cashier-1', name: 'Cashier' },
    closedBy: null,
  };
  const deadlock = () =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock; try restarting transaction`', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '1213', message: 'Deadlock found when trying to get lock; try restarting transaction' },
    });

  interface Attempt {
    /** What the locking read of the open shift answers, or throws. */
    lockingRead: () => Promise<Array<{ id: string }>>;
    create?: () => Promise<unknown>;
  }

  /** One scripted transaction per attempt, in order. */
  function build(attempts: Attempt[]) {
    let call = 0;
    const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const step = attempts[Math.min(call++, attempts.length - 1)];
      return fn({
        $queryRaw: jest.fn(step.lockingRead),
        shift: { create: jest.fn(step.create ?? (async () => created)) },
        auditLog: { create: jest.fn(async () => ({})) },
      });
    });
    const service = new ShiftsService({ $transaction } as never, {} as never, new Clock());
    return { service, $transaction };
  }

  it('reruns a transaction the database chose as deadlock victim; the rerun finds the winner and answers 409 SHIFT_ALREADY_OPEN', async () => {
    const { service, $transaction } = build([
      { lockingRead: () => Promise.reject(deadlock()) },
      { lockingRead: async () => [{ id: 'shift-1' }] },
    ]);

    await expect(service.open({ openingCash: 10 }, actor)).rejects.toMatchObject({ response: { code: 'SHIFT_ALREADY_OPEN', details: { shiftId: 'shift-1' } } });
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('opens the shift when the rerun after a deadlock finds none open', async () => {
    const { service, $transaction } = build([{ lockingRead: () => Promise.reject(deadlock()) }, { lockingRead: async () => [] }]);

    await expect(service.open({ openingCash: 10 }, actor)).resolves.toMatchObject({ id: 'shift-9', variance: null });
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('answers a lost race on the unique key with the same 409, without a rerun', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: `Shift_shopId_openedById_openToken_key`', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'Shift_shopId_openedById_openToken_key' },
    });
    const { service, $transaction } = build([{ lockingRead: async () => [], create: () => Promise.reject(duplicate) }]);

    const answer = service.open({ openingCash: 10 }, actor);
    await expect(answer).rejects.toBeInstanceOf(ConflictException);
    await expect(answer).rejects.toMatchObject({ response: { code: 'SHIFT_ALREADY_OPEN' } });
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

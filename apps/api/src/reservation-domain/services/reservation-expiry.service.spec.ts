import { PrismaService } from '../../prisma/prisma.service';
import { InventoryMutationEngine } from '../../inventory-domain/services/inventory-mutation.engine';
import { ReservationExpiryService } from './reservation-expiry.service';

describe('ReservationExpiryService', () => {
  const expired = (id: string) => ({ id, shopId: 'shop-1', items: [] });

  it('sweeps one shop and releases every expired reservation in its own transaction, surviving a failed one', async () => {
    const findMany = jest.fn().mockResolvedValue([expired('r1'), expired('r2'), expired('r3')]);
    const $transaction = jest
      .fn()
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => fn({ stockReservation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }))
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => fn({ stockReservation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }));
    const prisma = { stockReservation: { findMany }, $transaction } as unknown as PrismaService;
    const service = new ReservationExpiryService(prisma, {} as InventoryMutationEngine);

    const released = await service.releaseExpiredReservations('shop-1');

    expect(released).toBe(2);
    expect($transaction).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ shopId: 'shop-1' });
  });
});

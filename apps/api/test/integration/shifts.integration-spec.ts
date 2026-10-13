/**
 * Shifts (roadmap 8.3): the database, not only the service, allows one open
 * shift per cashier. `Shift.openToken` is 'OPEN' while open and NULL once
 * closed; the unique key (shopId, openedById, openToken) ignores the NULLs.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OPEN_TOKEN, ShiftsService } from '../../src/shifts/shifts.service';
import { actorFor, bootApp, createShop, errorCode, tenantRunner, TestShop } from './pos-fixtures';

describe('shifts: one open shift per cashier, enforced by the database (roadmap 8.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let shifts: ShiftsService;
  let shop: TestShop;
  let run: ReturnType<typeof tenantRunner>;

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    shifts = app.get(ShiftsService);
    run = tenantRunner(app);
    shop = await createShop(app, 'shift', { resolveLocation: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  const asCashier = <T>(fn: () => Promise<T>) => run.as(shop.shopId, shop.cashierId, Role.CASHIER, fn);
  const cashier = () => actorFor(shop, shop.cashierId, Role.CASHIER);

  it('opens with the token, refuses a second open, and clears the token on close', async () => {
    const opened = await asCashier(() => shifts.open({ openingCash: 500 }, cashier()));
    expect(opened.status).toBe('OPEN');
    expect((await run.system(() => prisma.shift.findUniqueOrThrow({ where: { id: opened.id } }))).openToken).toBe(OPEN_TOKEN);

    await expect(asCashier(() => shifts.open({ openingCash: 100 }, cashier()))).rejects.toMatchObject({ response: { code: 'SHIFT_ALREADY_OPEN' } });

    const closed = await asCashier(() => shifts.close({ closingCash: 500 }, cashier()));
    expect(closed.status).toBe('CLOSED');
    expect((await run.system(() => prisma.shift.findUniqueOrThrow({ where: { id: closed.id } }))).openToken).toBeNull();

    // Any number of closed shifts coexist; a new open one is allowed again.
    const reopened = await asCashier(() => shifts.open({ openingCash: 200 }, cashier()));
    expect(reopened.id).not.toBe(opened.id);
    await asCashier(() => shifts.close({ closingCash: 200 }, cashier()));
  });

  it('the key refuses a second OPEN row written around the service', async () => {
    const opened = await asCashier(() => shifts.open({ openingCash: 50 }, cashier()));
    const direct = run.system(() =>
      prisma.shift.create({
        data: { shopId: shop.shopId, openedById: shop.cashierId, openingCash: 1, expectedCash: 1, status: 'OPEN', openToken: OPEN_TOKEN },
      }),
    );
    await expect(direct).rejects.toMatchObject({ code: 'P2002' });
    await asCashier(() => shifts.close({ closingCash: 50 }, cashier(), opened.id));
  });

  it('concurrent opens: exactly one succeeds, the rest answer 409 SHIFT_ALREADY_OPEN', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => asCashier(() => shifts.open({ openingCash: 10 }, cashier()))));
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    expect(new Set(lost.map((a) => errorCode(a.reason)))).toEqual(new Set(['SHIFT_ALREADY_OPEN']));

    const openRows = await run.system(() => prisma.shift.count({ where: { shopId: shop.shopId, openedById: shop.cashierId, status: 'OPEN' } }));
    expect(openRows).toBe(1);
    await asCashier(() => shifts.close({ closingCash: 10 }, cashier()));
  });

  it('a manager may close the cashier\'s shift by id; the cashier can open again afterwards', async () => {
    const opened = await asCashier(() => shifts.open({ openingCash: 75 }, cashier()));
    const manager = actorFor(shop, shop.ownerId, Role.OWNER);
    const closed = await run.as(shop.shopId, shop.ownerId, Role.OWNER, () => shifts.close({ closingCash: 75 }, manager, opened.id));
    expect(closed.closedBy?.id).toBe(shop.ownerId);
    const again = await asCashier(() => shifts.open({ openingCash: 1 }, cashier()));
    await asCashier(() => shifts.close({ closingCash: 1 }, cashier(), again.id));
  });

  it('the unique key exists on the database (migration 20261004090000_shift_open_token)', async () => {
    const rows = await run.system(
      () => prisma.$queryRaw<Array<{ COLUMN_NAME: string }>>`
        SELECT COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Shift' AND INDEX_NAME = 'Shift_shopId_openedById_openToken_key' AND NON_UNIQUE = 0
        ORDER BY SEQ_IN_INDEX
      `,
    );
    expect(rows.map((r) => r.COLUMN_NAME)).toEqual(['shopId', 'openedById', 'openToken']);
  });
});


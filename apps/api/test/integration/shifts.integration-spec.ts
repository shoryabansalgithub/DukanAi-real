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

  it('?businessDate lists exactly the shifts open at some point of that day in the shop\'s zone, a running one from earlier days included', async () => {
    // A shop of its own, so the shifts the other cases leave behind do not count. Asia/Kolkata (UTC+5:30):
    // 10 March 2026 runs from 2026-03-09T18:30Z to 2026-03-10T18:30Z.
    const day = await createShop(app, 'shiftday', { resolveLocation: false });
    const at = (iso: string) => new Date(iso);
    const insert = (key: string, openedById: string, openedAt: string, closedAt: string | null) =>
      run.system(() =>
        prisma.shift.create({
          data: {
            shopId: day.shopId,
            openedById,
            openingCash: 0,
            expectedCash: 0,
            status: closedAt ? 'CLOSED' : 'OPEN',
            openToken: closedAt ? null : OPEN_TOKEN,
            openedAt: at(openedAt),
            closedAt: closedAt ? at(closedAt) : null,
            notes: key,
          },
        }),
      );
    const ids = {
      before: (await insert('before', day.cashierId, '2026-03-08T10:00:00Z', '2026-03-09T12:00:00Z')).id,
      endsAtMidnight: (await insert('endsAtMidnight', day.cashierId, '2026-03-09T15:00:00Z', '2026-03-09T18:30:00Z')).id,
      overnight: (await insert('overnight', day.cashierId, '2026-03-09T17:00:00Z', '2026-03-09T19:00:00Z')).id,
      daytime: (await insert('daytime', day.cashierId, '2026-03-10T04:00:00Z', '2026-03-10T10:00:00Z')).id,
      nextDay: (await insert('nextDay', day.cashierId, '2026-03-10T18:30:00Z', '2026-03-10T20:00:00Z')).id,
      running: (await insert('running', day.ownerId, '2026-03-01T04:00:00Z', null)).id,
    };

    const owner = actorFor(day, day.ownerId, Role.OWNER);
    const asOwner = await run.as(day.shopId, day.ownerId, Role.OWNER, () => shifts.list({ businessDate: '2026-03-10' }, owner));
    // `endsAtMidnight` closed at the very start of the 10th and `nextDay` opened at its end: neither was open during it.
    expect(new Set(asOwner.items.map((s) => s.id))).toEqual(new Set([ids.overnight, ids.daytime, ids.running]));
    expect(asOwner.total).toBe(3);

    // A cashier still sees only their own shifts.
    const asCashierOfDay = await run.as(day.shopId, day.cashierId, Role.CASHIER, () =>
      shifts.list({ businessDate: '2026-03-10' }, actorFor(day, day.cashierId, Role.CASHIER)),
    );
    expect(new Set(asCashierOfDay.items.map((s) => s.id))).toEqual(new Set([ids.overnight, ids.daytime]));

    // The day before: everything that ran on the 9th, the overnight shift included.
    const before = await run.as(day.shopId, day.ownerId, Role.OWNER, () => shifts.list({ businessDate: '2026-03-09' }, owner));
    expect(new Set(before.items.map((s) => s.id))).toEqual(new Set([ids.before, ids.endsAtMidnight, ids.overnight, ids.running]));

    // Without the filter every shift of the shop is listed; an impossible date is a 400.
    const all = await run.as(day.shopId, day.ownerId, Role.OWNER, () => shifts.list({}, owner));
    expect(all.total).toBe(6);
    await expect(run.as(day.shopId, day.ownerId, Role.OWNER, () => shifts.list({ businessDate: '2026-02-30' }, owner))).rejects.toMatchObject({
      response: { code: 'INVALID_DATE' },
    });
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


import { PrismaClient, ReconciliationRunStatus, ReconciliationTrigger } from '@prisma/client';
import { SWEPT_SHOP_STATUSES } from '../common/sweeps/per-shop-sweep';
import { ReconciliationReport } from '../reconciliation/reconciliation-engine';
import { parseReconcileArgs, reconcileCommand, RECONCILE_USAGE } from './reconcile';
import { REVOKE_USAGE, revokeAllSessionsCommand } from './revoke-all-sessions';
import { CliUsageError, runCli } from './run-cli';

// 2026-10-08 07:30 UTC = 13:00 in Asia/Kolkata (the default zone), 03:30 in New York.
const NOW = new Date('2026-10-08T07:30:00Z');

type Shop = { id: string; name: string; settings: { timezone: string | null } | null };
const shop = (id: string, timezone: string | null = null): Shop => ({ id, name: `Shop ${id}`, settings: timezone ? { timezone } : null });

function report(businessDate: string, timeZone: string, status: 'CLEAN' | 'DRIFT'): ReconciliationReport {
  const drifts = status === 'DRIFT' ? [{ check: 'stock' as const, subject: 'item i1', detail: 'onHand', expected: '1.000', actual: '2.000', difference: '1.000' }] : [];
  return {
    businessDate,
    timeZone,
    startedAt: NOW,
    finishedAt: NOW,
    status,
    driftCount: drifts.length,
    checks: [{ name: 'stock', status, figures: { items: 1 }, drifts, notes: [] }],
    summary: {
      businessDate,
      timeZone,
      windowStart: '',
      windowEnd: '',
      sales: { count: 2, total: '10.00' },
      returns: { count: 0, total: '0.00' },
      cancellations: { count: 0, total: '0.00' },
      repayments: { count: 0, total: '0.00' },
      tenders: { CASH: '10.00', BANK: '0.00', UDHAR: '0.00' },
      netSales: '10.00',
      postings: {},
      shiftsChecked: 0,
      itemsChecked: 1,
      productsChecked: 1,
    },
  };
}

/** A fake client: the shops it knows, every run row it was asked to write. */
function fakeDb(shops: Shop[]) {
  const runs: Array<Record<string, unknown>> = [];
  const db = {
    shop: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => shops.find((s) => s.id === where.id) ?? null),
      findMany: jest.fn(async () => shops),
    },
    reconciliationRun: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run-${runs.length + 1}`, ...data };
        runs.push(row);
        return row;
      }),
    },
    $disconnect: jest.fn(async () => undefined),
  };
  return { db, runs, client: db as unknown as PrismaClient };
}

function harness(shops: Shop[], outcome: (shopId: string, businessDate: string, timeZone: string) => ReconciliationReport | Error) {
  const { db, runs, client } = fakeDb(shops);
  const out: string[] = [];
  const err: string[] = [];
  const engine = jest.fn(async (_db: unknown, o: { shopId: string; businessDate: string; timeZone: string }) => {
    const result = outcome(o.shopId, o.businessDate, o.timeZone);
    if (result instanceof Error) throw result;
    return result;
  });
  const command = reconcileCommand({ connect: () => client, engine: engine as never, now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { db, runs, out, err, engine, command };
}

describe('operator commands shipped in the image (roadmap 9.22)', () => {
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  describe('runCli', () => {
    it('answers the exit code the command returns', async () => {
      await expect(runCli(async () => 1, [])).resolves.toBe(1);
    });

    it('answers 2 with the message on stderr when the command throws, and never rejects', async () => {
      await expect(
        runCli(async () => {
          throw new CliUsageError('DATABASE_URL is not set');
        }, []),
      ).resolves.toBe(2);
      expect(consoleError).toHaveBeenCalledWith('error: DATABASE_URL is not set');
    });
  });

  describe('reconcile arguments', () => {
    it('takes one shop or every shop, never both or neither', () => {
      expect(parseReconcileArgs(['--shop', 's1'])).toEqual({ shopId: 's1', allShops: false, date: undefined, json: false });
      expect(parseReconcileArgs(['--all-shops', '--date', '2026-10-07', '--json'])).toEqual({ shopId: undefined, allShops: true, date: '2026-10-07', json: true });
      expect(() => parseReconcileArgs([])).toThrow(CliUsageError);
      expect(() => parseReconcileArgs(['--shop', 's1', '--all-shops'])).toThrow(CliUsageError);
    });

    it('refuses a malformed date and an unknown option', () => {
      expect(() => parseReconcileArgs(['--shop', 's1', '--date', '07-10-2026'])).toThrow('--date must be YYYY-MM-DD');
      expect(() => parseReconcileArgs(['--shop', 's1', '--shops'])).toThrow();
    });

    it('prints the usage for --help without touching the database', async () => {
      const connect = jest.fn();
      const out: string[] = [];
      await expect(runCli(reconcileCommand({ connect, out: (l) => out.push(l) }), ['--help'])).resolves.toBe(0);
      expect(out).toEqual([RECONCILE_USAGE]);
      expect(connect).not.toHaveBeenCalled();
    });

    it('refuses to start without DATABASE_URL', async () => {
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        await expect(runCli(reconcileCommand(), ['--shop', 's1'])).resolves.toBe(2);
        expect(consoleError).toHaveBeenCalledWith('error: DATABASE_URL is not set');
      } finally {
        if (saved !== undefined) process.env.DATABASE_URL = saved;
      }
    });
  });

  describe('reconcile --shop', () => {
    it("reconciles today so far in the shop's timezone, records a CLI run and exits 0 when clean", async () => {
      const h = harness([shop('s1')], (_id, date, tz) => report(date, tz, 'CLEAN'));
      await expect(runCli(h.command, ['--shop', 's1'])).resolves.toBe(0);
      expect(h.engine).toHaveBeenCalledWith(expect.anything(), { shopId: 's1', timeZone: 'Asia/Kolkata', businessDate: '2026-10-08', now: NOW });
      expect(h.runs).toEqual([expect.objectContaining({ shopId: 's1', businessDate: '2026-10-08', trigger: ReconciliationTrigger.CLI, status: ReconciliationRunStatus.CLEAN, driftCount: 0 })]);
      expect(h.out[0]).toBe('Shop s1 (Shop s1)');
      expect(h.out[1]).toBe('Reconciliation of 2026-10-08 (Asia/Kolkata), run run-1: CLEAN (0 drift(s))');
      expect(h.db.$disconnect).toHaveBeenCalled();
    });

    it('exits 1 on drift and names it', async () => {
      const h = harness([shop('s1')], (_id, date, tz) => report(date, tz, 'DRIFT'));
      await expect(runCli(h.command, ['--shop', 's1', '--date', '2026-10-07'])).resolves.toBe(1);
      expect(h.out).toContain('               DRIFT item i1: onHand: expected 1.000, actual 2.000 (difference 1.000)');
      expect(h.runs[0]).toMatchObject({ businessDate: '2026-10-07', status: ReconciliationRunStatus.DRIFT, driftCount: 1 });
    });

    it('prints the recorded run as JSON with the shop', async () => {
      const h = harness([shop('s1')], (_id, date, tz) => report(date, tz, 'CLEAN'));
      await expect(runCli(h.command, ['--shop', 's1', '--json'])).resolves.toBe(0);
      expect(JSON.parse(h.out.join('\n'))).toMatchObject({ id: 'run-1', status: 'CLEAN', trigger: 'CLI', shop: { id: 's1', name: 'Shop s1' } });
    });

    it('records a failed run as FAILED, exits 2 and still disconnects', async () => {
      const h = harness([shop('s1')], () => new Error('connection lost'));
      await expect(runCli(h.command, ['--shop', 's1'])).resolves.toBe(2);
      expect(h.runs).toEqual([expect.objectContaining({ status: ReconciliationRunStatus.FAILED, error: 'connection lost', trigger: ReconciliationTrigger.CLI })]);
      expect(consoleError).toHaveBeenCalledWith('error: reconciliation failed: connection lost (recorded as run run-1)');
      expect(h.db.$disconnect).toHaveBeenCalled();
    });

    it('refuses an unknown shop and a day that has not started', async () => {
      const h = harness([shop('s1')], (_id, date, tz) => report(date, tz, 'CLEAN'));
      await expect(runCli(h.command, ['--shop', 'nope'])).resolves.toBe(2);
      expect(consoleError).toHaveBeenCalledWith('error: shop nope does not exist');
      await expect(runCli(h.command, ['--shop', 's1', '--date', '2026-10-09'])).resolves.toBe(2);
      expect(consoleError).toHaveBeenCalledWith('error: 2026-10-09 has not started in Asia/Kolkata');
      expect(h.runs).toEqual([]);
    });
  });

  describe('reconcile --all-shops (the catch-up after a missed night)', () => {
    it("visits every shop the nightly sweep visits, each on its own previous business day, and exits 0 when all are clean", async () => {
      const h = harness([shop('a'), shop('b', 'America/New_York')], (_id, date, tz) => report(date, tz, 'CLEAN'));
      await expect(runCli(h.command, ['--all-shops'])).resolves.toBe(0);
      expect(h.db.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: SWEPT_SHOP_STATUSES } } }));
      // 07:30 UTC is 2026-10-08 in Kolkata (previous day 10-07) and 2026-10-08 03:30 in New York (previous day 10-07).
      expect(h.engine.mock.calls.map(([, o]) => [o.shopId, o.businessDate, o.timeZone])).toEqual([
        ['a', '2026-10-07', 'Asia/Kolkata'],
        ['b', '2026-10-07', 'America/New_York'],
      ]);
      expect(h.runs.map((r) => r.trigger)).toEqual([ReconciliationTrigger.CLI, ReconciliationTrigger.CLI]);
      expect(h.out.at(-1)).toBe('Reconciliation of 2 shop(s), each on its previous business day: 2 clean, 0 with drift, 0 failed, 0 skipped');
    });

    it('keeps going past a drift and a failure, records each, and exits 2 when a run failed', async () => {
      const h = harness([shop('a'), shop('b'), shop('c')], (id, date, tz) => (id === 'b' ? new Error('lock wait timeout') : report(date, tz, id === 'c' ? 'DRIFT' : 'CLEAN')));
      await expect(runCli(h.command, ['--all-shops', '--date', '2026-10-07'])).resolves.toBe(2);
      expect(h.runs.map((r) => [r.shopId, r.status])).toEqual([
        ['a', ReconciliationRunStatus.CLEAN],
        ['b', ReconciliationRunStatus.FAILED],
        ['c', ReconciliationRunStatus.DRIFT],
      ]);
      expect(h.err).toEqual(['Shop b (Shop b): FAILED 2026-10-07: lock wait timeout; run run-2']);
      expect(h.out).toContain('Shop a (Shop a): CLEAN 2026-10-07 (2 sale(s)); run run-1');
      expect(h.out).toContain('               DRIFT item i1: onHand: expected 1.000, actual 2.000 (difference 1.000)');
      expect(h.out.at(-1)).toBe('Reconciliation of 3 shop(s) for 2026-10-07: 1 clean, 1 with drift, 1 failed, 0 skipped');
    });

    it('exits 1 when a shop drifted and none failed', async () => {
      const h = harness([shop('a'), shop('b')], (id, date, tz) => report(date, tz, id === 'b' ? 'DRIFT' : 'CLEAN'));
      await expect(runCli(h.command, ['--all-shops', '--date', '2026-10-07'])).resolves.toBe(1);
    });

    it('skips a shop whose day has not started in its timezone instead of stopping the others', async () => {
      // 2026-10-08 has started in Kolkata (13:00) but it is still 10-07 in Honolulu (21:30).
      const h = harness([shop('a'), shop('b', 'Pacific/Honolulu')], (_id, date, tz) => report(date, tz, 'CLEAN'));
      await expect(runCli(h.command, ['--all-shops', '--date', '2026-10-08', '--json'])).resolves.toBe(0);
      expect(JSON.parse(h.out.join('\n'))).toEqual([
        expect.objectContaining({ shopId: 'a', status: 'CLEAN', shop: { id: 'a', name: 'Shop a' } }),
        { shop: { id: 'b', name: 'Shop b' }, businessDate: '2026-10-08', status: 'SKIPPED', reason: '2026-10-08 has not started in Pacific/Honolulu' },
      ]);
      expect(h.runs).toHaveLength(1);
    });
  });

  describe('revoke-all-sessions', () => {
    function sessions() {
      const tx = { refreshToken: { updateMany: jest.fn(async () => ({ count: 3 })) }, user: { updateMany: jest.fn(async () => ({ count: 2 })) } };
      const db = {
        user: { count: jest.fn(async () => 2), findFirst: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => (where.email === 'owner@shop.test' || where.id === 'u1' ? { id: 'u1', email: 'owner@shop.test' } : null)) },
        refreshToken: { count: jest.fn(async () => 3) },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
        $disconnect: jest.fn(async () => undefined),
      };
      const out: string[] = [];
      const command = revokeAllSessionsCommand({ connect: () => db as unknown as PrismaClient, out: (l) => out.push(l) });
      return { db, tx, out, command };
    }

    it('only counts without --yes', async () => {
      const s = sessions();
      await expect(runCli(s.command, [])).resolves.toBe(0);
      expect(s.out).toEqual(['Scope: every user', 'Live refresh tokens: 3; users whose tokenVersion will advance: 2', 'Dry run: nothing changed. Pass --yes to end these sessions.']);
      expect(s.db.$transaction).not.toHaveBeenCalled();
      expect(s.db.$disconnect).toHaveBeenCalled();
    });

    it('revokes every session with --yes, or one user by email', async () => {
      const s = sessions();
      await expect(runCli(s.command, ['--yes'])).resolves.toBe(0);
      expect(s.tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { isRevoked: false }, data: { isRevoked: true } });
      expect(s.out.at(-1)).toMatch(/^Done: 3 refresh token\(s\) revoked, tokenVersion advanced for 2 user\(s\)/);
      await expect(runCli(s.command, ['--user', 'owner@shop.test', '--yes'])).resolves.toBe(0);
      expect(s.tx.user.updateMany).toHaveBeenLastCalledWith({ where: { id: 'u1' }, data: { tokenVersion: { increment: 1 } } });
    });

    it('refuses an unknown user and prints the usage for --help', async () => {
      const s = sessions();
      await expect(runCli(s.command, ['--user', 'nobody@shop.test', '--yes'])).resolves.toBe(2);
      expect(consoleError).toHaveBeenCalledWith('error: no user matches "nobody@shop.test"');
      expect(s.db.$transaction).not.toHaveBeenCalled();
      await expect(runCli(s.command, ['--help'])).resolves.toBe(0);
      expect(s.out.at(-1)).toBe(REVOKE_USAGE);
    });
  });
});

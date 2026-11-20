import { expect, test } from '@playwright/test';
import { RefreshHandoff } from '../src/lib/refresh-handoff';

/**
 * Roadmap 9.17: the simulated business day signed every owner out after
 * exactly one access-token lifetime. Several jwt callbacks of one browser
 * presented the same refresh token: the first exchange consumed it and the
 * late callers, still holding the old cookie, tripped the API's reuse
 * detection, which ends every session of the account. The hand-off keeps
 * the successor for a grace window and answers the late callers with it.
 * Pure logic, no browser: the spec runs in the ordinary e2e project.
 */
type Outcome = { ok: true; accessToken: string } | { ok: false };

test.describe('refresh token hand-off (roadmap 9.17)', () => {
  test('callers that present a token rotated moments ago get the same successor, not a second exchange', async () => {
    let clock = 1_000_000;
    let exchanges = 0;
    const handoff = new RefreshHandoff<Outcome>({ graceMs: 120_000, now: () => clock });
    const exchange = () => {
      exchanges += 1;
      return new Promise<Outcome>((resolve) => setTimeout(() => resolve({ ok: true, accessToken: `access-${exchanges}` }), 20));
    };

    // Two callers while the exchange is in flight, and three more after it settled.
    const [a, b] = await Promise.all([handoff.once('rt-1', exchange), handoff.once('rt-1', exchange)]);
    clock += 5_000;
    const c = await handoff.once('rt-1', exchange);
    clock += 30_000;
    const d = await handoff.once('rt-1', exchange);
    expect(exchanges).toBe(1);
    expect([a, b, c, d].every((o) => o.ok && o.accessToken === 'access-1')).toBe(true);

    // A different token is its own exchange.
    const e = await handoff.once('rt-2', exchange);
    expect(exchanges).toBe(2);
    expect(e).toEqual({ ok: true, accessToken: 'access-2' });
    expect(handoff.size).toBe(2);

    // Past the grace window the old token is forgotten (the API would refuse it anyway).
    clock += 120_001;
    expect(handoff.size).toBe(0);
    await handoff.once('rt-1', exchange);
    expect(exchanges).toBe(3);
  });

  test('a failed exchange is not kept, so the next caller tries again', async () => {
    let attempts = 0;
    const handoff = new RefreshHandoff<Outcome>({ graceMs: 60_000 });
    const failing = async (): Promise<Outcome> => {
      attempts += 1;
      return { ok: false };
    };
    expect(await handoff.once('rt-3', failing)).toEqual({ ok: false });
    expect(await handoff.once('rt-3', failing)).toEqual({ ok: false });
    expect(attempts).toBe(2);
    expect(handoff.size).toBe(0);

    const throwing = async (): Promise<Outcome> => {
      throw new Error('network');
    };
    await expect(handoff.once('rt-4', throwing)).rejects.toThrow('network');
    expect(handoff.size).toBe(0);
  });

  test('the table is bounded', () => {
    const handoff = new RefreshHandoff<Outcome>({ graceMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) void handoff.once(`rt-${i}`, async () => ({ ok: true, accessToken: `a${i}` }));
    expect(handoff.size).toBe(3);
  });
});

/**
 * Durations in configuration: an integer followed by a unit, `ms`, `s`, `m`,
 * `h` or `d` (e.g. `15m`, `7d`). The refresh-token lifetimes used to be read
 * with `/^(\d+)/` and treated as days, so `12h` meant twelve days.
 */
export const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function isDuration(value: unknown): boolean {
  return typeof value === 'string' && DURATION_PATTERN.test(value.trim());
}

/** Milliseconds for a validated duration string; throws on anything else. */
export function durationToMs(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Not a duration: ${JSON.stringify(value)} (expected e.g. 15m, 12h, 7d)`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

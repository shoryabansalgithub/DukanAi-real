import { durationToMs, isDuration } from './duration';

describe('durations', () => {
  it.each([
    ['500ms', 500],
    ['45s', 45_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
    [' 30d ', 2_592_000_000],
  ])('converts %j to %i ms', (value, ms) => {
    expect(isDuration(value)).toBe(true);
    expect(durationToMs(value)).toBe(ms);
  });

  it.each(['', '7', 'd7', '7 days', '1.5h', '7w', 7, undefined])('rejects %j', (value) => {
    expect(isDuration(value)).toBe(false);
    expect(() => durationToMs(String(value))).toThrow(/Not a duration/);
  });
});

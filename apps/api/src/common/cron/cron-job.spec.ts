import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { validateSync } from 'class-validator';
import { CronConfig } from '../../config/domains/cron.config';
import { createCronJob } from './cron-job';

describe('createCronJob (schedules in CRON_TIMEZONE)', () => {
  const noop = () => undefined;

  it("reads the expression in the configured zone, not the container's", () => {
    // 2026-10-11 20:00 UTC is 01:30 on 10-12 in India: the nightly run is due at 20:00 UTC, not 01:30 UTC.
    jest.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      const kolkata = createCronJob('30 1 * * *', noop, { timeZone: 'Asia/Kolkata' });
      const utc = createCronJob('30 1 * * *', noop, { timeZone: 'UTC' });
      expect(kolkata.nextDate().toUTC().toISO()).toBe('2026-10-11T20:00:00.000Z');
      expect(utc.nextDate().toUTC().toISO()).toBe('2026-10-12T01:30:00.000Z');
      expect(kolkata.cronTime.timeZone).toBe('Asia/Kolkata');
      expect(kolkata.isActive).toBe(false); // the caller registers and starts it
    } finally {
      jest.useRealTimers();
    }
  });

  it('defaults to Asia/Kolkata and refuses a name that is not an IANA zone', () => {
    expect(new CronConfig().timeZone).toBe('Asia/Kolkata');
    const errors = (timeZone: string) => validateSync(Object.assign(new CronConfig(), { timeZone })).filter((e) => e.property === 'timeZone');
    expect(errors('Asia/Kolkata')).toEqual([]);
    expect(errors('UTC')).toEqual([]);
    expect(errors('America/New_York')).toEqual([]);
    for (const bad of ['IST', '+05:30', 'Mars/Olympus_Mons', '', 'Asia/Kolkata; DROP']) {
      expect(errors(bad)).toHaveLength(1);
    }
  });
});

describe('every scheduler goes through createCronJob', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts') ? [full] : [];
    });

  it('no source builds a CronJob itself (it would run in the container zone, UTC in the images)', () => {
    const own = path.join(SRC, 'common', 'cron', 'cron-job.ts');
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== own)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => /new CronJob\s*\(|CronJob\.from\s*\(/.test(line))
          .map(({ i }) => `${path.relative(SRC, file)}:${i + 1}`),
      );
    expect(offenders).toEqual([]);
  });
});

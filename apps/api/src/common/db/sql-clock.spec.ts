import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

/**
 * Roadmap 8.2: every timestamp the API writes comes from the application
 * clock as a UTC parameter. Prisma stores and reads DateTime columns as UTC,
 * while MySQL's NOW() / CURRENT_TIMESTAMP answer in the session time zone, so
 * a raw statement that used the database clock produced values that were off
 * by the server's offset whenever that zone was not UTC, and compared
 * app-written instants (`nextAttemptAt`) against a different clock. This scan
 * fails on any database clock function in application source (specs excluded).
 */
const SRC = path.resolve(__dirname, '..', '..');
const DB_CLOCK = /\b(NOW|CURRENT_TIMESTAMP|UTC_TIMESTAMP|SYSDATE|CURDATE|CURTIME|LOCALTIME|LOCALTIMESTAMP|UNIX_TIMESTAMP)\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

describe('raw SQL uses the application clock (roadmap 8.2)', () => {
  it('no application source calls a database clock function', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => DB_CLOCK.test(line))
        .map(({ i }) => `${path.relative(SRC, file)}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});

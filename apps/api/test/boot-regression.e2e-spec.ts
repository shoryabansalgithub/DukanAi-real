import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * Regression tests for the two production boot defects:
 *
 * 1. `start:prod` pointed at `dist/main`, but the entrypoint compiles to
 *    `dist/src/main.js` (root-level .ts scripts widen tsc's rootDir), so
 *    production start died with MODULE_NOT_FOUND.
 * 2. `bufferLogs: true` without `abortOnError: false` + a bootstrap catch made
 *    every startup crash exit 1 with ZERO bytes of output, so boot failures
 *    were unattributable from deployment logs.
 *
 * Reverting either fix makes the corresponding test fail.
 */
describe('production boot regressions', () => {
  const apiRoot = path.resolve(__dirname, '..');
  // Single source of truth: whatever `start:prod` runs is what must exist and boot.
  const pkg = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
  const startTarget = (pkg.scripts['start:prod'] as string).replace(/^node\s+/, '');
  const entrypoint = path.join(apiRoot, startTarget.endsWith('.js') ? startTarget : `${startTarget}.js`);

  beforeAll(() => {
    if (!existsSync(entrypoint)) {
      execSync('npm run build', { cwd: apiRoot, stdio: 'inherit' });
    }
  }, 180_000);

  it('start:prod points at the compiled entrypoint', () => {
    expect(existsSync(entrypoint)).toBe(true);
  });

  it('a startup crash is reported on stderr instead of dying silently', () => {
    // PORT=not-a-number always fails config validation, whatever else is in the
    // environment, so NestFactory.create rejects before anything can listen.
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: apiRoot,
      env: { PATH: process.env.PATH, PORT: 'not-a-number' },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).not.toBe(0);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toMatch(/\[Bootstrap(\]| FATAL\])/);
  }, 90_000);
});

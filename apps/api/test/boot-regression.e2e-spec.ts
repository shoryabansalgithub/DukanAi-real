import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * Regression tests for production boot defects:
 *
 * 1. `start:prod` pointed at `dist/main`, but the entrypoint compiles to
 *    `dist/src/main.js` (root-level .ts scripts widen tsc's rootDir), so
 *    production start died with MODULE_NOT_FOUND.
 * 2. `bufferLogs: true` without `abortOnError: false` + a bootstrap catch made
 *    every startup crash exit 1 with ZERO bytes of output, so boot failures
 *    were unattributable from deployment logs.
 * 3. Roadmap phase 2 boot matrix: a missing or placeholder secret, no
 *    NODE_ENV, a placeholder FRONTEND_URL and AUTH_DISABLED in production
 *    each refuse to start with a message naming the variable (later rows add
 *    a relative STORAGE_ROOT, LOG_LEVEL=debug and a placeholder SENTRY_DSN).
 *
 * Reverting any fix makes the corresponding test fail. Every boot here fails
 * at configuration validation, before anything dials the database or Redis.
 */
describe('production boot regressions', () => {
  const apiRoot = path.resolve(__dirname, '..');
  // Single source of truth: whatever `start:prod` runs is what must exist and boot.
  const pkg = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
  const startProd = pkg.scripts['start:prod'] as string;
  const startTarget = /(?:^|\s)node\s+(\S+)/.exec(startProd)?.[1] ?? '';
  const entrypoint = path.join(apiRoot, startTarget.endsWith('.js') ? startTarget : `${startTarget}.js`);

  /** A production environment that passes every config rule; each case breaks exactly one thing. */
  const validProduction: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    PORT: '3999',
    FRONTEND_URL: 'https://app.example.com',
    JWT_SECRET: 'k9vP2xR7mQ4tW8zB1nL6cH3jF5dS0aY2eU4iO7pA9sD1fG3h',
    JWT_EXPIRES_IN: '1d',
    JWT_REFRESH_EXPIRES_IN: '7d',
    DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/dukaanai',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
  };

  const boot = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [entrypoint], { cwd: apiRoot, env, encoding: 'utf8', timeout: 60_000 });

  const outputOf = (result: ReturnType<typeof boot>) => `${result.stdout ?? ''}${result.stderr ?? ''}`;

  beforeAll(() => {
    if (!existsSync(entrypoint)) {
      execSync('npm run build', { cwd: apiRoot, stdio: 'inherit' });
    }
  }, 180_000);

  it('start:prod points at the compiled entrypoint and pins NODE_ENV=production', () => {
    expect(startProd).toMatch(/\bNODE_ENV=production\b/);
    expect(existsSync(entrypoint)).toBe(true);
  });

  it('a startup crash is reported on stderr instead of dying silently', () => {
    // PORT=not-a-number always fails config validation, whatever else is in the
    // environment, so NestFactory.create rejects before anything can listen.
    const result = boot({ ...validProduction, PORT: 'not-a-number' });

    expect(result.status).not.toBe(0);
    expect(outputOf(result)).toMatch(/\[Bootstrap(\]| FATAL\])/);
  }, 90_000);

  describe('boot matrix: each misconfiguration refuses to start with a visible reason', () => {
    it.each<[string, NodeJS.ProcessEnv, RegExp]>([
      ['no NODE_ENV', { ...validProduction, NODE_ENV: undefined }, /NODE_ENV must be set to development, test or production/],
      // Blank rather than absent: with NODE_ENV=production the committed template
      // fills an absent JWT_SECRET with its placeholder, which is the next case.
      ['a blank JWT_SECRET', { ...validProduction, JWT_SECRET: '' }, /jwtSecret is not set/],
      ['the committed placeholder JWT_SECRET', { ...validProduction, JWT_SECRET: '___REPLACE_ME_IN_PRODUCTION___' }, /jwtSecret is a template placeholder/],
      ['a short JWT_SECRET', { ...validProduction, JWT_SECRET: 'tooshort' }, /jwtSecret is shorter than 32 characters/],
      ['a placeholder FRONTEND_URL', { ...validProduction, FRONTEND_URL: '___REPLACE_ME_IN_PRODUCTION___' }, /frontendUrl is a template placeholder/],
      ['AUTH_DISABLED=true in production', { ...validProduction, AUTH_DISABLED: 'true' }, /AUTH_DISABLED=true is only accepted when NODE_ENV is development or test/],
      // Roadmap 7.5: a relative root would depend on the working directory of whoever starts the process.
      ['a relative STORAGE_ROOT', { ...validProduction, STORAGE_ROOT: './data/storage' }, /storageRoot is relative/],
      // Roadmap 7.6: no debug output in production, and a placeholder DSN would silently disable error tracking.
      ['LOG_LEVEL=debug in production', { ...validProduction, LOG_LEVEL: 'debug' }, /logLevel is "debug": production prints at most the "log" level/],
      ['a placeholder SENTRY_DSN', { ...validProduction, SENTRY_DSN: '___REPLACE_ME_IN_PRODUCTION___' }, /sentryDsn is a template placeholder/],
    ])('%s', (_label, env, reason) => {
      const result = boot(env);

      expect(result.status).not.toBe(0);
      const output = outputOf(result);
      expect(output).toMatch(/\[Bootstrap FATAL\]/);
      expect(output).toMatch(reason);
    }, 90_000);
  });
});

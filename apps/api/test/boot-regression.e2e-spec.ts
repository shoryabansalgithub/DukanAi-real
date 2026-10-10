import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

interface BootCase {
  label: string;
  /** Overrides of validProduction; null unsets the variable. */
  env: Record<string, string | null>;
  /** Regular expression the output must match. */
  reason: string;
}

interface BootMatrix {
  fatalMarker: string;
  validProduction: Record<string, string>;
  cases: BootCase[];
}

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
 *    The cases live in test/boot-matrix.json so that the certification of a
 *    release candidate (scripts/certify/boot-matrix.sh, roadmap 9.12) runs
 *    the same matrix against the API image.
 *
 * 4. Roadmap 9.22: the operator commands the runbooks name (`node
 *    dist/cli/reconcile`, `node dist/cli/revoke-all-sessions`) are part of
 *    the build: the documented `npm run` forms answered `ts-node: not found`
 *    in the image, which carries `dist` and no `scripts/`.
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

  /** A production environment that passes every config rule; each case breaks exactly one thing (test/boot-matrix.json). */
  const matrix = JSON.parse(readFileSync(path.join(__dirname, 'boot-matrix.json'), 'utf8')) as BootMatrix;
  const validProduction: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...matrix.validProduction };
  const fatalMarker = new RegExp(matrix.fatalMarker);
  const caseEnv = (overrides: Record<string, string | null>): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries({ ...validProduction, ...overrides }).filter(([, v]) => v !== null)) as NodeJS.ProcessEnv;

  const boot = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [entrypoint], { cwd: apiRoot, env, encoding: 'utf8', timeout: 60_000 });

  const outputOf = (result: ReturnType<typeof boot>) => `${result.stdout ?? ''}${result.stderr ?? ''}`;

  /** The operator commands a runbook or docs/SECRETS.md tells an operator to run in the API container (roadmap 9.22). */
  const commands = ['reconcile', 'revoke-all-sessions'].map((name) => ({ name, file: path.join(apiRoot, 'dist', 'cli', `${name}.js`) }));

  beforeAll(() => {
    if (!existsSync(entrypoint) || commands.some((c) => !existsSync(c.file))) {
      execSync('npm run build', { cwd: apiRoot, stdio: 'inherit' });
    }
  }, 180_000);

  it('start:prod points at the compiled entrypoint and pins NODE_ENV=production', () => {
    expect(startProd).toMatch(/\bNODE_ENV=production\b/);
    expect(existsSync(entrypoint)).toBe(true);
  });

  it('the build carries the operator commands, which run with node alone (the image has no scripts/ and no ts-node)', () => {
    for (const { name, file } of commands) {
      const run = (...args: string[]) => spawnSync(process.execPath, [file, ...args], { cwd: apiRoot, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
      const help = run('--help');
      expect({ name, status: help.status, usage: help.stdout.startsWith(`usage: ${name}`) }).toEqual({ name, status: 0, usage: true });
      // Without a database it refuses with the reason, exit 2, no stack trace.
      const bare = run(...(name === 'reconcile' ? ['--all-shops'] : []));
      expect({ name, status: bare.status, stderr: bare.stderr.trim() }).toEqual({ name, status: 2, stderr: 'error: DATABASE_URL is not set' });
    }
  }, 90_000);

  it('a startup crash is reported on stderr instead of dying silently', () => {
    // PORT=not-a-number always fails config validation, whatever else is in the
    // environment, so NestFactory.create rejects before anything can listen.
    const result = boot({ ...validProduction, PORT: 'not-a-number' });

    expect(result.status).not.toBe(0);
    expect(outputOf(result)).toMatch(/\[Bootstrap(\]| FATAL\])/);
  }, 90_000);

  describe('boot matrix: each misconfiguration refuses to start with a visible reason', () => {
    it('lists the nine refusal cases', () => {
      expect(matrix.cases.map((c) => c.label)).toEqual([
        'no NODE_ENV',
        'a blank JWT_SECRET',
        'the committed placeholder JWT_SECRET',
        'a short JWT_SECRET',
        'a placeholder FRONTEND_URL',
        'AUTH_DISABLED=true in production',
        'a relative STORAGE_ROOT',
        'LOG_LEVEL=debug in production',
        'a placeholder SENTRY_DSN',
      ]);
    });

    it.each(matrix.cases.map((c): [string, BootCase] => [c.label, c]))('%s', (_label, bootCase) => {
      const result = boot(caseEnv(bootCase.env));

      expect(result.status).not.toBe(0);
      const output = outputOf(result);
      expect(output).toMatch(fatalMarker);
      expect(output).toMatch(new RegExp(bootCase.reason));
    }, 90_000);
  });
});

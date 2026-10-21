import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Environment } from '../config/domains/app.config';
import { migrationFolderNames, PrismaService, unappliedMigrations } from './prisma.service';

// The module object prisma.service.ts calls writeSync on (an ES namespace import cannot be spied on).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs = require('node:fs') as typeof import('node:fs');

/**
 * Audit 2026-10-11, P1-16: an API started against a database behind its
 * build refused to boot only when one of four probed tables or columns was
 * missing, so a release whose migrations had not run (Kubernetes rolled the
 * API before the migration Job) served requests against the old schema.
 * Every migration the build carries must now be recorded as applied.
 */
describe('PrismaService migration history guard (audit P1-16)', () => {
  let dir: string;
  const realDir = PrismaService.migrationsDir;

  function migration(name: string, sql = true): void {
    mkdirSync(join(dir, name), { recursive: true });
    if (sql) writeFileSync(join(dir, name, 'migration.sql'), 'SELECT 1;\n');
  }

  /** The service's own method on a stand-in: no database, no Nest. */
  function fakeService(nodeEnv: Environment, query: () => Promise<Array<{ migration_name: string }>>) {
    const fake = {
      appConfig: { nodeEnv },
      tenantContextService: { runAsSuperAdmin: <T>(fn: () => T) => fn() },
      $queryRaw: jest.fn((..._args: unknown[]) => query()),
      logger: { log: jest.fn(), warn: jest.fn() },
    };
    const check = () => (PrismaService.prototype.assertMigrationsApplied as (this: unknown) => Promise<void>).call(fake);
    return { fake, check };
  }

  let stderr: jest.SpyInstance;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    migration('20260101000000_first');
    migration('20260201000000_second');
    migration('20260301000000_third');
    migration('not_a_migration', false);
    writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "mysql"\n');
    PrismaService.migrationsDir = dir;
    stderr = jest.spyOn(nodeFs, 'writeSync').mockImplementation(() => 0);
  });
  afterEach(() => {
    PrismaService.migrationsDir = realDir;
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the migration folders of a build (directories with a migration.sql, sorted)', () => {
    expect(migrationFolderNames(dir)).toEqual(['20260101000000_first', '20260201000000_second', '20260301000000_third']);
    expect(migrationFolderNames(join(dir, 'absent'))).toBeNull();
    expect(unappliedMigrations(['a', 'b', 'c'], ['c', 'a', 'z'])).toEqual(['b']);
  });

  it('resolves the repository folder the image carries (apps/api/prisma/migrations)', () => {
    const names = migrationFolderNames(realDir);
    expect(names).not.toBeNull();
    expect(names).toContain('20260717185000_schema_baseline');
  });

  it('boots when every migration of the build is applied, and when the database is ahead (a rollback)', async () => {
    const all = [{ migration_name: '20260101000000_first' }, { migration_name: '20260201000000_second' }, { migration_name: '20260301000000_third' }];
    await expect(fakeService(Environment.Production, async () => all).check()).resolves.toBeUndefined();
    await expect(fakeService(Environment.Production, async () => [...all, { migration_name: '20260401000000_newer_release' }]).check()).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('asks only for finished migrations that were not rolled back', async () => {
    const { fake, check } = fakeService(Environment.Production, async () => [
      { migration_name: '20260101000000_first' },
      { migration_name: '20260201000000_second' },
      { migration_name: '20260301000000_third' },
    ]);
    await check();
    const sql = (fake.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/FROM _prisma_migrations/);
    expect(sql).toMatch(/finished_at IS NOT NULL/);
    expect(sql).toMatch(/rolled_back_at IS NULL/);
  });

  it('refuses to boot when a migration of the build is not applied, naming it', async () => {
    const { check } = fakeService(Environment.Production, async () => [{ migration_name: '20260101000000_first' }, { migration_name: '20260301000000_third' }]);
    await expect(check()).rejects.toThrow('Database is behind this build: 1 migration(s) not applied (20260201000000_second)');
    const banner = String(stderr.mock.calls[0][1]);
    expect(banner).toContain('SCHEMA DRIFT DETECTED: 1 of the 3 migrations in this build is not applied');
    expect(banner).toContain('20260201000000_second');
    expect(banner).toContain('prisma migrate deploy');
  });

  it('refuses outside production too: a development database behind the checkout is the same drift', async () => {
    await expect(fakeService(Environment.Development, async () => []).check()).rejects.toThrow('3 migration(s) not applied');
  });

  it('treats a database without _prisma_migrations as having applied nothing', async () => {
    const missingTable = Object.assign(new Error("Raw query failed. Code: `1146`. Message: `Table 'dukaanai._prisma_migrations' doesn't exist`"), { code: 'P2010', meta: { code: '1146' } });
    await expect(fakeService(Environment.Production, () => Promise.reject(missingTable)).check()).rejects.toThrow('3 migration(s) not applied');
  });

  it('rethrows any other database error', async () => {
    const refused = Object.assign(new Error('connection lost'), { code: 'P1017' });
    await expect(fakeService(Environment.Production, () => Promise.reject(refused)).check()).rejects.toBe(refused);
  });

  it('without the migrations folder: production refuses, development warns and boots', async () => {
    PrismaService.migrationsDir = join(dir, 'absent');
    await expect(fakeService(Environment.Production, async () => []).check()).rejects.toThrow('Migration history cannot be verified');
    const dev = fakeService(Environment.Development, async () => []);
    await expect(dev.check()).resolves.toBeUndefined();
    expect(dev.fake.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Migration history not verified'));
    expect(dev.fake.$queryRaw).not.toHaveBeenCalled();
  });
});

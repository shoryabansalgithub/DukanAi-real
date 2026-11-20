import { Injectable, OnModuleInit, OnApplicationShutdown, Logger } from '@nestjs/common';
import { existsSync, readdirSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { tenantExtension } from './prisma-tenant.extension';
import { softDeleteTokenExtension } from './soft-delete-token';
import { AppConfig, Environment } from '../config/domains/app.config';
import { PrismaConfig } from '../config/domains/prisma.config';

/**
 * The migrations a build carries: every directory of `prisma/migrations`
 * holding a `migration.sql` (Prisma's layout), sorted. `null` when the
 * directory does not exist.
 */
export function migrationFolderNames(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}

/** The migrations of `expected` that are not in `applied`, in `expected`'s order. */
export function unappliedMigrations(expected: readonly string[], applied: Iterable<string>): string[] {
  const done = new Set(applied);
  return expected.filter((name) => !done.has(name));
}

/** A raw query against a table that does not exist (MySQL 1146 through Prisma's P2010). */
function isMissingTable(error: unknown): boolean {
  const { code, meta, message } = (error ?? {}) as { code?: string; meta?: { code?: unknown }; message?: string };
  return (code === 'P2010' && String(meta?.code) === '1146') || /_prisma_migrations.*(doesn't|does not) exist/i.test(message ?? '');
}

/** The schema drift banner, written straight to stderr (see assertSchemaInSync). */
function writeDriftBanner(lines: string[]): void {
  writeSync(
    2,
    [
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      ...lines,
      'Apply the pending migrations (never `prisma db push`, which bypasses the migration history):',
      '    cd apps/api && npx prisma migrate status && npx prisma migrate deploy',
      'or, in the API image (no npx there; compose runs the `migrate` service, Kubernetes the deploy/k8s/migrate Job):',
      '    /app/node_modules/.bin/prisma migrate status && /app/node_modules/.bin/prisma migrate deploy',
      'A migration recorded as failed or edited after it was applied is settled with',
      '    npx prisma migrate resolve --applied <name>   (or --rolled-back <name>)',
      'and then `migrate deploy` again; see apps/api/prisma/MIGRATIONS.md.',
      '(Ensure DATABASE_URL points at the right database first.)',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
    ].join('\n'),
  );
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * The migrations directory this build carries: `prisma/migrations` next to
   * `dist/` (the image copies `apps/api/prisma`) or next to `src/` (ts-node,
   * jest). Overridable for tests.
   */
  static migrationsDir = resolve(__dirname, '..', '..', 'prisma', 'migrations');

  /**
   * Production logs warnings and errors only. Elsewhere every query is
   * logged only when `PRISMA_LOG_QUERIES` says so (roadmap 5.8: the flag
   * used to be read into `PrismaConfig` and ignored, so a load test under
   * `NODE_ENV=test` measured the log writer rather than the API).
   */
  static logLevelsFor(appConfig: Pick<AppConfig, 'nodeEnv'>, prismaConfig: Pick<PrismaConfig, 'logQueries' | 'logLevelProduction' | 'logLevelDevelopment'>): string[] {
    if (appConfig.nodeEnv === Environment.Production) return prismaConfig.logLevelProduction;
    return prismaConfig.logQueries ? prismaConfig.logLevelDevelopment : prismaConfig.logLevelDevelopment.filter((level) => level !== 'query');
  }

  constructor(
    private readonly tenantContextService: TenantContextService,
    private readonly appConfig: AppConfig,
    prismaConfig: PrismaConfig,
  ) {
    super({
      log: PrismaService.logLevelsFor(appConfig, prismaConfig).map((level) => ({ emit: 'stdout', level })) as any,
    });

    const extended = this.$extends(tenantExtension(this.tenantContextService)).$extends(softDeleteTokenExtension());

    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in extended) {
          return extended[prop as keyof typeof extended];
        }
        return target[prop as keyof typeof target];
      }
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connection established');
    } catch (error) {
      this.logger.error('Failed to connect to database', error);
      throw error;
    }
    await this.assertMigrationsApplied();
    await this.assertSchemaInSync();
  }

  /**
   * Startup guard against a database behind the build (audit 2026-10-11,
   * P1-16): every migration in this build's `prisma/migrations` must be
   * recorded as finished (and not rolled back) in `_prisma_migrations`, or
   * the API refuses to boot with the drift message. A database AHEAD of the
   * build (the previous image after a rollback, apps/api/prisma/MIGRATIONS.md)
   * is fine: only a missing migration refuses. Without the directory the
   * history cannot be checked: production refuses (the image always carries
   * it), development and test warn and rely on the table probes.
   */
  async assertMigrationsApplied(): Promise<void> {
    const dir = PrismaService.migrationsDir;
    const expected = migrationFolderNames(dir);
    if (expected === null) {
      if (this.appConfig.nodeEnv === Environment.Production) {
        writeDriftBanner([`MIGRATION HISTORY UNVERIFIABLE: ${dir} does not exist in this build.`, 'A production build carries apps/api/prisma/migrations (apps/api/Dockerfile copies apps/api/prisma).']);
        throw new Error(`Migration history cannot be verified: ${dir} does not exist`);
      }
      this.logger.warn(`Migration history not verified: ${dir} does not exist (accepted outside production)`);
      return;
    }
    let applied: string[];
    try {
      const rows = await this.tenantContextService.runAsSuperAdmin(
        async () =>
          await this.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      );
      applied = rows.map((row) => row.migration_name);
    } catch (error: unknown) {
      if (!isMissingTable(error)) throw error;
      applied = [];
    }
    const missing = unappliedMigrations(expected, applied);
    if (missing.length > 0) {
      const shown = missing.slice(0, 10);
      writeDriftBanner([
        `SCHEMA DRIFT DETECTED: ${missing.length} of the ${expected.length} migrations in this build ${missing.length === 1 ? 'is' : 'are'} not applied to the database:`,
        ...shown.map((name) => `    ${name}`),
        ...(missing.length > shown.length ? [`    ... and ${missing.length - shown.length} more`] : []),
      ]);
      throw new Error(`Database is behind this build: ${missing.length} migration(s) not applied (${shown.join(', ')}${missing.length > shown.length ? ', ...' : ''})`);
    }
    this.logger.log(`Migration history verified: all ${expected.length} migrations of this build are applied`);
  }

  /**
   * Startup guard against schema/database drift beyond the migration history
   * (assertMigrationsApplied): a table or column removed by hand.
   *
   * Probes columns and tables that have historically drifted (e.g. the
   * Customer enterprise columns and the Expense table) with cheap queries.
   * When Prisma reports a missing table (P2021) or column (P2022), boot is
   * aborted with a loud, actionable message instead of letting every request
   * that touches the drifted model 500 at runtime.
   */
  private async assertSchemaInSync(): Promise<void> {
    try {
      await this.tenantContextService.runAsSuperAdmin(() =>
        Promise.all([
          this.customer.findFirst({ select: { id: true, type: true, kycStatus: true } }),
          this.supplier.findFirst({ select: { id: true, contactPerson: true, pendingPayables: true } }),
          this.expense.findFirst({ select: { id: true } }),
          this.notification.findFirst({ select: { id: true } }),
        ]),
      );
      this.logger.log('Database schema probe passed - schema and database are in sync');
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === 'P2021' || code === 'P2022') {
        const detail =
          code === 'P2021'
            ? 'a table defined in prisma/schema.prisma does not exist in the database'
            : 'a column defined in prisma/schema.prisma does not exist in the database';
        // Written straight to stderr, not through the Nest logger: `bufferLogs:
        // true` in main.ts discards buffered logs when bootstrap throws, which
        // would swallow exactly the message the operator needs to see.
        writeDriftBanner([`SCHEMA DRIFT DETECTED: ${detail}.`, `Prisma error: ${(error as Error).message?.split('\n').pop()?.trim()}`]);
      }
      throw error;
    }
  }

  /**
   * Disconnects in `onApplicationShutdown`, the last shutdown phase, after the
   * HTTP server has stopped and the BullMQ workers have finished their active
   * jobs (roadmap 7.3). As an `onModuleDestroy` hook it ran first, and every
   * request still in flight failed against a closed client.
   */
  async onApplicationShutdown() {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}

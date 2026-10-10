import { Injectable, OnModuleInit, OnApplicationShutdown, Logger } from '@nestjs/common';
import { writeSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { tenantExtension } from './prisma-tenant.extension';
import { softDeleteTokenExtension } from './soft-delete-token';
import { AppConfig, Environment } from '../config/domains/app.config';
import { PrismaConfig } from '../config/domains/prisma.config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

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
    appConfig: AppConfig,
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
    await this.assertSchemaInSync();
  }

  /**
   * Startup guard against schema/database drift.
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
        writeSync(
          2,
          [
            '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
            `SCHEMA DRIFT DETECTED: ${detail}.`,
            `Prisma error: ${(error as Error).message?.split('\n').pop()?.trim()}`,
            'Apply the pending migrations (never `prisma db push`, which bypasses the migration history):',
            '    cd apps/api && npx prisma migrate status && npx prisma migrate deploy',
            'or, in the API image (no npx there; compose runs the `migrate` service):',
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

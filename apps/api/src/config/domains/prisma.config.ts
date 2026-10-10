import { Injectable } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv } from '../hydrate-from-env';

/** Prisma client logging. Hydrated with `hydrateFromEnv`. */
@Injectable()
@ConfigDomain({ owner: 'Prisma', feature: 'Configuration', version: '2.0.0', description: 'PrismaConfig Domain' })
export class PrismaConfig {
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('PRISMA_LOG_QUERIES')
  logQueries: boolean = false;

  readonly logLevelProduction: string[] = ['warn', 'error'];
  readonly logLevelDevelopment: string[] = ['query', 'info', 'warn', 'error'];
}

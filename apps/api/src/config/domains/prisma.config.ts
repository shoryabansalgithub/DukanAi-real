import { Injectable } from '@nestjs/common';
import { IsBoolean, IsInt, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv, IntegerFromEnv } from '../hydrate-from-env';

/** Prisma client logging. Hydrated with `hydrateFromEnv`. */
@Injectable()
@ConfigDomain({ owner: 'Prisma', feature: 'Configuration', version: '2.0.0', description: 'PrismaConfig Domain' })
export class PrismaConfig {
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('PRISMA_LOG_QUERIES')
  logQueries: boolean = false;

  /** Queries slower than this (ms) are logged as slow. */
  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('PRISMA_SLOW_QUERY_THRESHOLD')
  slowQueryThreshold: number = 1000;

  readonly logLevelProduction: string[] = ['warn', 'error'];
  readonly logLevelDevelopment: string[] = ['query', 'info', 'warn', 'error'];
}

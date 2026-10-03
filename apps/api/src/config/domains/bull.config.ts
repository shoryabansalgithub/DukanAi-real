import { Injectable } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv, IntegerFromEnv, StringFromEnv } from '../hydrate-from-env';

export const BULL_BACKOFF_TYPES = ['exponential', 'fixed'] as const;
export type BullBackoffType = (typeof BULL_BACKOFF_TYPES)[number];

/**
 * Default job options for the BullMQ queues. Hydrated with `hydrateFromEnv`:
 * booleans accept true/false spellings only (the old implicit conversion
 * turned the string "false" into true), an unset or blank variable keeps the
 * default, and anything else fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Bull', feature: 'Configuration', version: '2.0.0', description: 'BullConfig Domain' })
export class BullConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('BULL_ATTEMPTS')
  defaultAttempts: number = 3;

  @IsIn(BULL_BACKOFF_TYPES)
  @StringFromEnv()
  @EnvVariable('BULL_BACKOFF_TYPE')
  backoffType: BullBackoffType = 'exponential';

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('BULL_BACKOFF_DELAY')
  backoffDelay: number = 1000;

  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('BULL_REMOVE_ON_COMPLETE')
  removeOnComplete: boolean = true;

  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('BULL_REMOVE_ON_FAIL')
  removeOnFail: boolean = false;
}

import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Sales listing sizes and credit defaults. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Sales', feature: 'Sales Events', version: '1.1.0', description: 'Configuration for Sales Domain Features' })
export class SalesFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SALES_DEFAULT_PAGINATION_LIMIT')
  defaultPaginationLimit: number = 50;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SALES_RECENT_EVENTS_LIMIT')
  recentEventsLimit: number = 100;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('SALES_CREDIT_HOLD_THRESHOLD')
  creditHoldThreshold: number = 10000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('SALES_DEFAULT_CREDIT_LIMIT')
  defaultCreditLimit: number = 5000;
}

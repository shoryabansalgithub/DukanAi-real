import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * The sales-events list size and the default customer credit limit. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Sales', feature: 'Sales Events', version: '1.1.0', description: 'Configuration for Sales Domain Features' })
export class SalesFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SALES_RECENT_EVENTS_LIMIT')
  recentEventsLimit: number = 100;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('SALES_DEFAULT_CREDIT_LIMIT')
  defaultCreditLimit: number = 5000;
}

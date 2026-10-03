import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Purchase event listing size. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Purchase', feature: 'Purchase Events', version: '1.1.0', description: 'Configuration for Purchase Domain Features' })
export class PurchaseFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('PURCHASE_DEAD_LETTER_PAGINATION_LIMIT')
  deadLetterPaginationLimit: number = 50;
}

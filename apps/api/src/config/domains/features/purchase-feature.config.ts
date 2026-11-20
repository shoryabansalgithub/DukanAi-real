import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, IsNumber, Max, Min } from 'class-validator';
import { IntegerFromEnv, NumberFromEnv } from '../../hydrate-from-env';

/**
 * Purchase event listing size and the vendor-bill price match. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
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

  /** How far (in percent of the purchase order's net unit cost) a vendor bill's unit price may differ before the three-way match refuses it (400 VENDOR_BILL_PRICE_MISMATCH); 0 means it must match to the paisa. */
  @IsNumber()
  @Min(0)
  @Max(100)
  @NumberFromEnv()
  @EnvVariable('PURCHASE_BILL_PRICE_TOLERANCE_PERCENT')
  billPriceTolerancePercent: number = 0;
}

import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Analytics list sizes. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Analytics', feature: 'Analytics Domain', version: '1.1.0', description: 'Configuration for Analytics Domain Features' })
export class AnalyticsFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('ANALYTICS_TREND_ANALYSIS_LIMIT')
  trendAnalysisLimit: number = 12;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('ANALYTICS_RECENT_ORDERS_LIMIT')
  recentOrdersLimit: number = 20;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('ANALYTICS_TOP_VENDORS_LIMIT')
  topVendorsLimit: number = 5;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('ANALYTICS_TOP_PRODUCTS_LIMIT')
  topProductsLimit: number = 10;
}

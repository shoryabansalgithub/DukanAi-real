import { Injectable } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv } from '../hydrate-from-env';

/**
 * Cache TTLs and sizes. Hydrated with `hydrateFromEnv`: an unset or blank
 * variable keeps the default below, `0` is a real value, and anything that is
 * not an integer fails validation at boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Cache', feature: 'Configuration', version: '1.0.0', description: 'CacheConfig Domain' })
export class CacheConfig {
  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_TTL')
  ttl: number = 3600000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_VENDOR_BILL_TTL_MS')
  vendorBillTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_SUPPLIER_CREDIT_TTL_MS')
  supplierCreditTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_PURCHASE_RETURN_TTL_MS')
  purchaseReturnTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_PURCHASE_TTL_MS')
  purchaseTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_EVENTS_STATS_TTL_MS')
  eventsStatsTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_GRN_TTL_MS')
  grnTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_CUSTOMER_SEARCH_TTL_MS')
  customerSearchTtlMs: number = 60000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_ANALYTICS_DASHBOARD_TTL_MS')
  analyticsDashboardTtlMs: number = 3600000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_ANALYTICS_VENDOR_PERF_TTL_MS')
  analyticsVendorPerfTtlMs: number = 900000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_ANALYTICS_TREND_TTL_MS')
  analyticsTrendTtlMs: number = 3600000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_VALIDATION_RULE_ENGINE_TTL_MS')
  validationRuleEngineTtlMs: number = 900000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_INVENTORY_DRIFT_TTL_SECONDS')
  inventoryDriftTtlSeconds: number = 3600;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_INVENTORY_STOCK_TTL_SECONDS')
  inventoryStockTtlSeconds: number = 3600;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_SEARCH_STOCK_TTL_MS')
  searchStockTtlMs: number = 30000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('CACHE_ANALYTICS_KPI_TTL_MS')
  analyticsKpiTtlMs: number = 60000;
}

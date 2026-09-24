import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IsOptional, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

@Injectable()
@ConfigDomain({ owner: 'Cache', feature: 'Configuration', version: '1.0.0', description: 'CacheConfig Domain' })
export class CacheConfig {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600000))
  @EnvVariable('CACHE_TTL')
  ttl: number = 3600000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1000))
  @EnvVariable('CACHE_MAX_ITEMS')
  maxItems: number = 1000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_VENDOR_BILL_TTL_MS')
  vendorBillTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_SUPPLIER_CREDIT_TTL_MS')
  supplierCreditTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 900000))
  @EnvVariable('CACHE_SALES_ORDER_TTL_MS')
  salesOrderTtlMs: number = 900000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_PURCHASE_RETURN_TTL_MS')
  purchaseReturnTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_PURCHASE_TTL_MS')
  purchaseTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_EVENTS_STATS_TTL_MS')
  eventsStatsTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600000))
  @EnvVariable('CACHE_PRICING_TTL_MS')
  pricingTtlMs: number = 3600000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 300000))
  @EnvVariable('CACHE_INVOICE_TTL_MS')
  invoiceTtlMs: number = 300000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_GRN_TTL_MS')
  grnTtlMs: number = 60000;

  @EnvVariable('CACHE_CUSTOMER_SEARCH_TTL_MS')
  customerSearchTtlMs: number = 60000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600000))
  @EnvVariable('CACHE_ANALYTICS_DASHBOARD_TTL_MS')
  analyticsDashboardTtlMs: number = 3600000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 900000))
  @EnvVariable('CACHE_ANALYTICS_VENDOR_PERF_TTL_MS')
  analyticsVendorPerfTtlMs: number = 900000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600000))
  @EnvVariable('CACHE_ANALYTICS_TREND_TTL_MS')
  analyticsTrendTtlMs: number = 3600000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 300000))
  @EnvVariable('CACHE_SEARCH_ENGINE_TTL_MS')
  searchEngineTtlMs: number = 300000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 900000))
  @EnvVariable('CACHE_VALIDATION_RULE_ENGINE_TTL_MS')
  validationRuleEngineTtlMs: number = 900000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600))
  @EnvVariable('CACHE_INVENTORY_DRIFT_TTL_SECONDS')
  inventoryDriftTtlSeconds: number = 3600;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3600))
  @EnvVariable('CACHE_INVENTORY_STOCK_TTL_SECONDS')
  inventoryStockTtlSeconds: number = 3600;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 30000))
  @EnvVariable('CACHE_SEARCH_STOCK_TTL_MS')
  searchStockTtlMs: number = 30000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  @EnvVariable('CACHE_ANALYTICS_KPI_TTL_MS')
  analyticsKpiTtlMs: number = 60000;
}

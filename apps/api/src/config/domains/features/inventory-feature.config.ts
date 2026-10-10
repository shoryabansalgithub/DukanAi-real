import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Inventory list sizes and reconciliation windows. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Inventory', feature: 'Inventory Domain', version: '1.1.0', description: 'Configuration for Inventory Features' })
export class InventoryFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_RECENT_ADJUSTMENTS_LIMIT')
  recentAdjustmentsLimit: number = 100;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_RECENT_MOVEMENTS_LIMIT')
  recentMovementsLimit: number = 100;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_UNRESOLVED_ALERTS_LIMIT')
  unresolvedAlertsLimit: number = 50;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_LIST_LIMIT')
  inventoryListLimit: number = 50;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_RECON_BATCH_SIZE')
  reconBatchSize: number = 1000;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_RECON_LOCK_TTL_MS')
  reconLockTtlMs: number = 300000;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_MAX_PRINT_QUANTITY')
  maxPrintQuantity: number = 1000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('INVENTORY_RECON_LOOKBACK_MS')
  reconLookbackMs: number = 86400000;
}

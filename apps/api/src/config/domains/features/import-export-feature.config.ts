import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, Min } from 'class-validator';
import { IntegerFromEnv } from '../../hydrate-from-env';

/**
 * Import/export job listing size. Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'Import/Export', feature: 'Data Import/Export', version: '1.1.0', description: 'Configuration for Data Import and Export' })
export class ImportExportFeatureConfig {
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('IMPORT_EXPORT_LIST_LIMIT')
  exportListLimit: number = 50;
}

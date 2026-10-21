import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IsInt, IsString, IsOptional, Max, Min } from 'class-validator';
import { IsProductionAbsolutePath } from '../validation/env-rules';
import { IntegerFromEnv } from '../hydrate-from-env';

@Injectable()
@ConfigDomain({ owner: 'Storage', feature: 'Configuration', version: '1.0.0', description: 'StorageConfig Domain' })
export class StorageConfig {
  /**
   * Local document root (billing evidence). Production requires an absolute
   * path (roadmap 7.5); elsewhere a relative value is resolved against the
   * working directory once, at boot, by `StoragePathBuilder`.
   */
  @IsString()
  @IsOptional()
  @IsProductionAbsolutePath()
  @EnvVariable('STORAGE_ROOT')
  readonly storageRoot?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_REGION')
  readonly s3Region?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_ENDPOINT')
  readonly s3Endpoint?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_ACCESS_KEY')
  readonly s3AccessKey?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_SECRET_KEY')
  readonly s3SecretKey?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_BUCKET')
  readonly s3Bucket?: string;

  @IsString()
  @IsOptional()
  @EnvVariable('S3_PUBLIC_URL')
  readonly s3PublicUrl?: string;

  /**
   * Zips `POST /storage/backup` keeps per shop and backup type; older ones
   * are removed after each successful run (every run writes its own file).
   */
  @IsInt()
  @Min(1)
  @Max(365)
  @IntegerFromEnv()
  @EnvVariable('STORAGE_BACKUP_KEEP')
  readonly backupKeep: number = 7;
}

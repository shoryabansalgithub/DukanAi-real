import { Injectable } from '@nestjs/common';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv, StringFromEnv } from '../hydrate-from-env';

const MiB = 1024 * 1024;

/**
 * Multipart upload limits (roadmap 5.1, audit P1-9) for the disk-stored
 * routes (product media, product imports). The storage documents keep their
 * caps in `storage-security.constants.ts` and OCR in `OcrFeatureConfig`;
 * every route is bounded by the server, never by the client.
 * Hydrated with `hydrateFromEnv`: blank keeps the default, garbage fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'platform', feature: 'UploadConfig', version: '1.0.0', description: 'Multipart upload limits and temp storage' })
export class UploadConfig {
  /** Largest product / variant media file (image, video or document) accepted by `POST /media/upload/*`. */
  @IsInt()
  @Min(64 * 1024)
  @Max(500 * MiB)
  @IntegerFromEnv()
  @EnvVariable('UPLOAD_MAX_MEDIA_BYTES')
  maxMediaBytes: number = 50 * MiB;

  /** Largest CSV / JSON file accepted by `POST /imports/products/upload`. */
  @IsInt()
  @Min(1024)
  @Max(500 * MiB)
  @IntegerFromEnv()
  @EnvVariable('UPLOAD_MAX_IMPORT_BYTES')
  maxImportBytes: number = 20 * MiB;

  /**
   * Directory multer streams uploads into before a service verifies and moves
   * them (relative paths resolve against the working directory). Nothing under
   * it is committed (`uploads/.gitignore`); a rejected upload is unlinked at once.
   */
  @IsString()
  @Matches(/^[^\0]{1,512}$/)
  @StringFromEnv()
  @EnvVariable('UPLOAD_TEMP_DIR')
  tempDir: string = 'uploads/tmp';
}

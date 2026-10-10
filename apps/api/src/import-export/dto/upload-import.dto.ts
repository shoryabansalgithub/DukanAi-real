import { ImportMode } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';
import { ListQueryDto } from '../../common/pagination';

/**
 * The modes an import runs in (roadmap 9.20): UPSERT creates and updates,
 * CREATE_ONLY leaves rows already in the shop alone, UPDATE_ONLY creates
 * nothing. MERGE and REPLACE were never implemented and are refused.
 */
export const SUPPORTED_IMPORT_MODES = [ImportMode.UPSERT, ImportMode.CREATE_ONLY, ImportMode.UPDATE_ONLY] as const;

/** Multipart fields of `POST /imports/{products,customers,opening-stock}/upload`. */
export class UploadImportDto {
  @IsOptional()
  @IsIn(SUPPORTED_IMPORT_MODES, { message: `mode must be one of ${SUPPORTED_IMPORT_MODES.join(', ')}` })
  mode?: ImportMode;

  /** "true": validate and plan every row and write only the report (multipart fields are strings). */
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'dryRun must be "true" or "false"' })
  dryRun?: 'true' | 'false';
}

/** `GET /imports/jobs/:id/rows?status=&skip=&take=`. */
export class ImportRowsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(['SUCCESS', 'ERROR', 'SKIPPED'])
  status?: 'SUCCESS' | 'ERROR' | 'SKIPPED';
}

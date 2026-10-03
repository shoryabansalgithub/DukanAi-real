import { ImportMode } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/** Multipart field of `POST /imports/products/upload`. */
export class UploadImportDto {
  @IsOptional()
  @IsEnum(ImportMode)
  mode?: ImportMode;
}

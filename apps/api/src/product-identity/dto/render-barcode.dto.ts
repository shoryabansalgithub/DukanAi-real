import { BarcodeFormat } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class RenderBarcodeQueryDto {
  @IsOptional()
  @IsEnum(BarcodeFormat)
  format?: BarcodeFormat;
}

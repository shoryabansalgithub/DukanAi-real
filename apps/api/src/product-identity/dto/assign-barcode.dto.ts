import { BarcodeFormat } from '@prisma/client';
import { IsEnum, IsString, MaxLength } from 'class-validator';

export class AssignBarcodeDto {
  @IsString()
  @MaxLength(64)
  code: string;

  @IsEnum(BarcodeFormat)
  format: BarcodeFormat;
}

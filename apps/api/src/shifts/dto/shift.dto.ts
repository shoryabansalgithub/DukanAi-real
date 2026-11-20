import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OpenShiftDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(10_000_000) @ApiProperty() openingCash: number;
  @IsString() @IsOptional() @MaxLength(191) @ApiPropertyOptional() notes?: string;
}

export class CloseShiftDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(10_000_000) @ApiProperty() closingCash: number;
  @IsString() @IsOptional() @MaxLength(191) @ApiPropertyOptional() notes?: string;
}

export class ListShiftsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) @ApiPropertyOptional({ default: 25 }) take?: number;
  /**
   * Only the shifts open at some moment of this business day (YYYY-MM-DD, in the shop's time zone): opened
   * before the day ends and closed after it starts, so a shift left running since an earlier day counts.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'businessDate must be YYYY-MM-DD' })
  @ApiPropertyOptional({ example: '2026-11-20' })
  businessDate?: string;
}

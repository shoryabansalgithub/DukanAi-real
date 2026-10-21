import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
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
}

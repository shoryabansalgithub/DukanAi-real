import { IsBoolean, IsEmail, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenderType } from '@prisma/client';
import { CustomerType } from '../domain/enums';

export class CreateCustomerDto {
  @IsString() @IsNotEmpty() @MaxLength(100) @ApiProperty() name: string;
  @IsString() @IsNotEmpty() @MaxLength(20) @ApiProperty() phone: string;
  @IsOptional() @IsEmail() @ApiPropertyOptional() email?: string;
  @IsOptional() @IsString() @MaxLength(500) @ApiPropertyOptional() address?: string;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() city?: string;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() state?: string;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100_000_000) @ApiPropertyOptional() creditLimit?: number;
  @IsOptional() @IsString() @MaxLength(1000) @ApiPropertyOptional() notes?: string;
  @IsOptional() @IsEnum(CustomerType) @ApiPropertyOptional({ enum: CustomerType }) type?: CustomerType;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) @ApiPropertyOptional() name?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) @ApiPropertyOptional() phone?: string;
  @IsOptional() @IsEmail() @ApiPropertyOptional() email?: string;
  @IsOptional() @IsString() @MaxLength(500) @ApiPropertyOptional() address?: string;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() city?: string;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() state?: string;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100_000_000) @ApiPropertyOptional() creditLimit?: number;
  @IsOptional() @IsString() @MaxLength(1000) @ApiPropertyOptional() notes?: string;
  @IsOptional() @IsBoolean() @ApiPropertyOptional() isActive?: boolean;
}

export class RecordPaymentDto {
  @IsUUID() @ApiProperty() idempotencyKey: string;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.01) @Max(100_000_000) @ApiProperty() amount: number;
  @IsEnum(TenderType) @ApiProperty({ enum: TenderType }) tender: TenderType;
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() reference?: string;
  @IsOptional() @IsString() @MaxLength(500) @ApiPropertyOptional() notes?: string;
  @IsOptional() @IsBoolean() @ApiPropertyOptional({ description: 'Allow paying more than the outstanding balance (advance / store credit)' }) allowAdvance?: boolean;
}

export class ListCustomersDto {
  @IsOptional() @IsString() @MaxLength(100) @ApiPropertyOptional() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) @ApiPropertyOptional({ default: 25 }) take?: number;
}

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) @ApiPropertyOptional({ default: 25 }) take?: number;
}

export class SearchCustomersDto {
  @IsString() @IsNotEmpty() @MaxLength(100) @ApiProperty() query: string;
  @IsOptional() @IsInt() @Min(0) @ApiPropertyOptional() skip?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) @ApiPropertyOptional() take?: number;
}

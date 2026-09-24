import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceStatus, InvoiceType, PaymentMode } from '@prisma/client';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ListInvoicesDto {
  @IsOptional() @Matches(DATE_RE) @ApiPropertyOptional({ example: '2026-09-18' }) from?: string;
  @IsOptional() @Matches(DATE_RE) @ApiPropertyOptional({ example: '2026-09-18' }) to?: string;
  @IsOptional() @IsEnum(InvoiceStatus) @ApiPropertyOptional({ enum: InvoiceStatus }) status?: InvoiceStatus;
  @IsOptional() @IsEnum(InvoiceType) @ApiPropertyOptional({ enum: InvoiceType }) type?: InvoiceType;
  @IsOptional() @IsString() @ApiPropertyOptional() customerId?: string;
  @IsOptional() @IsEnum(PaymentMode) @ApiPropertyOptional({ enum: PaymentMode }) paymentMode?: PaymentMode;
  @IsOptional() @IsString() @MaxLength(50) @ApiPropertyOptional() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) @ApiPropertyOptional({ default: 25 }) take?: number;
}

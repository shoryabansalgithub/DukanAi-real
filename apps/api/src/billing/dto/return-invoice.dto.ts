import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenderType } from '@prisma/client';

export enum ReturnReason {
  CUSTOMER_CHANGED_MIND = 'CUSTOMER_CHANGED_MIND',
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  DAMAGED = 'DAMAGED',
  WRONG_ITEM = 'WRONG_ITEM',
  BILLING_ERROR = 'BILLING_ERROR',
  EXPIRED = 'EXPIRED',
  OTHER = 'OTHER',
}

export class ReturnItemDto {
  @IsString() @IsNotEmpty() @ApiProperty() invoiceItemId: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @ApiProperty()
  quantity: number;
}

export class RefundDto {
  @IsEnum(TenderType) @IsOptional() @ApiPropertyOptional({ enum: TenderType, default: 'CASH' }) tender?: TenderType;
  @IsString() @IsOptional() @MaxLength(100) @ApiPropertyOptional() reference?: string;
}

export class ReturnInvoiceDto {
  @IsUUID() @IsNotEmpty() @ApiProperty() idempotencyKey: string;

  @IsString() @IsNotEmpty() @ApiProperty() invoiceId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  @IsOptional()
  @ApiPropertyOptional({ type: [ReturnItemDto], description: 'Omit to return everything still returnable' })
  items?: ReturnItemDto[];

  @IsEnum(ReturnReason) @IsOptional() @ApiPropertyOptional({ enum: ReturnReason }) reason?: ReturnReason;
  @IsString() @IsOptional() @MaxLength(500) @ApiPropertyOptional() notes?: string;

  @ValidateNested() @Type(() => RefundDto) @IsOptional() @ApiPropertyOptional({ type: RefundDto }) refund?: RefundDto;
}

export class CancelInvoiceDto {
  @IsString() @IsNotEmpty() @MaxLength(500) @ApiProperty() reason: string;
}

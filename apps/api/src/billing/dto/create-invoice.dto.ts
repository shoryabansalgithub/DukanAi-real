import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GstRate, PaymentMode, ProductUnit, TenderType } from '@prisma/client';

/** Largest money value the invoice tables store (Prisma Decimal(10,2)). */
export const MONEY_MAX_NUMBER = 99_999_999.99;

/**
 * An ad-hoc line that is not in the catalogue (a service charge, a one-off
 * item). Priced and taxed by the same engine as catalogue lines, never touches
 * inventory, carries no cess and is never merged with another line.
 */
export class CustomItemDto {
  @IsString() @Length(1, 120) @ApiProperty() name: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(MONEY_MAX_NUMBER)
  @ApiProperty()
  unitPrice: number;

  @IsEnum(GstRate) @ApiProperty({ enum: GstRate }) gstRate: GstRate;

  @IsEnum(ProductUnit) @IsOptional() @ApiPropertyOptional({ enum: ProductUnit, default: 'PCS' }) unit?: ProductUnit;
}

export class InvoiceItemDto {
  /** Catalogue product. Exactly one of `productId` / `custom` is required. */
  @ValidateIf((o) => o.custom === undefined)
  @IsString()
  @IsNotEmpty()
  @ApiPropertyOptional()
  productId?: string;

  @ValidateIf((o) => o.productId === undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => CustomItemDto)
  @ApiPropertyOptional({ type: CustomItemDto })
  custom?: CustomItemDto;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(1_000_000)
  @ApiProperty()
  quantity: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  @IsOptional()
  @ApiPropertyOptional()
  discountPercent?: number;
}

export class PaymentTenderDto {
  @IsEnum(TenderType) @ApiProperty({ enum: TenderType }) tender: TenderType;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MONEY_MAX_NUMBER)
  @ApiProperty()
  amount: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MONEY_MAX_NUMBER)
  @IsOptional()
  @ApiPropertyOptional({ description: 'Cash handed over (CASH only); change = tenderedAmount - amount' })
  tenderedAmount?: number;

  @IsString() @IsOptional() @MaxLength(100) @ApiPropertyOptional() reference?: string;
}

export class CreateInvoiceDto {
  @IsUUID() @IsNotEmpty() @ApiProperty() idempotencyKey: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  @ApiProperty({ type: [InvoiceItemDto] })
  items: InvoiceItemDto[];

  @IsString() @IsOptional() @ApiPropertyOptional() customerId?: string;
  @IsString() @IsOptional() @MaxLength(500) @ApiPropertyOptional() notes?: string;
  @IsString() @IsOptional() @ApiPropertyOptional() shiftId?: string;

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(MONEY_MAX_NUMBER) @IsOptional() @ApiPropertyOptional() discountAmount?: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) @IsOptional() @ApiPropertyOptional() discountPercentage?: number;
  @IsEnum(['FIXED_AMOUNT', 'PERCENTAGE']) @IsOptional() @ApiPropertyOptional({ enum: ['FIXED_AMOUNT', 'PERCENTAGE'] }) discountType?: string;

  @ValidateIf((o) => (o.discountAmount && o.discountAmount > 0) || (o.discountPercentage && o.discountPercentage > 0))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @ApiPropertyOptional()
  discountReason?: string;

  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PaymentTenderDto)
  @IsOptional()
  @ApiPropertyOptional({ type: [PaymentTenderDto] })
  payments?: PaymentTenderDto[];

  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(MONEY_MAX_NUMBER) @IsOptional() @ApiPropertyOptional() udharAmount?: number;

  /** @deprecated legacy clients: mapped onto `payments`. */
  @IsEnum(PaymentMode) @IsOptional() @ApiPropertyOptional({ enum: PaymentMode, deprecated: true }) paymentMode?: PaymentMode;
  /** @deprecated legacy clients: mapped onto `payments`. */
  @ValidateIf((o) => o.payments === undefined)
  @IsDefined()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @ApiPropertyOptional({ deprecated: true })
  amountPaid?: number;
}

import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export const TAX_MODES = ['EXCLUSIVE', 'INCLUSIVE'] as const;

export class PurchaseOrderItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsNumber()
  @Min(0)
  unitCost: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cgstRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sgstRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  igstRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cessRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  hsnSac?: string;

  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  binId?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

export class CreatePurchaseOrderDto {
  @IsString()
  supplierId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCenter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  priority?: string;

  @IsOptional()
  @IsDateString()
  expectedDelivery?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  exchangeRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string;

  @IsOptional()
  @IsIn(TAX_MODES)
  taxMode?: (typeof TAX_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  shippingInstructions?: string;
}

/** Draft edits: any subset of the creation fields; `supplierId` is fixed once the order exists. */
export class UpdatePurchaseDraftDto extends PartialType(CreatePurchaseOrderDto) {}

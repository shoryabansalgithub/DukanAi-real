import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export const PURCHASE_RETURN_TYPES = ['CREDIT', 'REPLACEMENT'] as const;

export class PurchaseReturnLineDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @IsString()
  purchaseOrderLineId?: string;

  @IsOptional()
  @IsString()
  grnLineId?: string;

  @IsNumber()
  @IsPositive()
  returnQuantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxPercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  condition?: string;
}

export class CreatePurchaseReturnDto {
  @IsString()
  supplierId: string;

  @IsOptional()
  @IsString()
  purchaseOrderId?: string;

  @IsOptional()
  @IsString()
  goodsReceiptId?: string;

  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnLineDto)
  lines: PurchaseReturnLineDto[];

  @IsOptional()
  @IsIn(PURCHASE_RETURN_TYPES)
  returnType?: (typeof PURCHASE_RETURN_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  priority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reasonCode?: string;

  @IsOptional()
  @IsDateString()
  expectedReturnDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;
}

export class DispatchShipmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  carrier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  trackingNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  vehicleNumber?: string;
}

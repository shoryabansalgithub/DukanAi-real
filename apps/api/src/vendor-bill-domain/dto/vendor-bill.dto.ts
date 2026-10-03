import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export const VENDOR_BILL_TAX_MODES = ['EXCLUSIVE', 'INCLUSIVE'] as const;

export class VendorBillLineDto {
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
  billedQuantity: number;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxPercentage?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

export class CreateVendorBillDto {
  @IsString()
  supplierId: string;

  @IsOptional()
  @IsString()
  purchaseOrderId?: string;

  @IsOptional()
  @IsString()
  goodsReceiptId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VendorBillLineDto)
  lines: VendorBillLineDto[];

  @IsOptional()
  @IsIn(VENDOR_BILL_TAX_MODES)
  taxMode?: (typeof VENDOR_BILL_TAX_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  invoiceNumber?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}

export class PayVendorBillDto {
  @IsNumber()
  @IsPositive()
  paymentAmount: number;

  /** CASH leaves the drawer (CR CASH); anything else credits BANK. */
  @IsOptional()
  @IsIn(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER'])
  tender?: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER';

  @IsOptional()
  @IsString()
  @MaxLength(191)
  reference?: string;

  /** Replaying the same key returns the bill as already paid instead of paying twice. */
  @IsOptional()
  @IsString()
  @MaxLength(191)
  idempotencyKey?: string;
}

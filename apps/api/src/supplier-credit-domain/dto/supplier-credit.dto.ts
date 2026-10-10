import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class SupplierCreditLineDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

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

  @IsNumber()
  @Min(0)
  totalAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

export class CreateSupplierCreditDto {
  @IsString()
  supplierId: string;

  @IsOptional()
  @IsString()
  purchaseReturnId?: string;

  @IsOptional()
  @IsString()
  vendorBillId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  creditSource?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SupplierCreditLineDto)
  lines: SupplierCreditLineDto[];
}

export class AllocateSupplierCreditDto {
  @IsString()
  vendorBillId: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}

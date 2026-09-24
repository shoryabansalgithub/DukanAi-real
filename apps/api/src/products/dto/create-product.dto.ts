import { IsString, IsOptional, IsNumber, IsBoolean, IsEnum, MaxLength, Min, Max } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { ProductType, ProductStatus, ProductUnit, GstRate } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsString()
  sku: string;

  /** Unique per shop across Product, ProductBarcode and ProductVariant (409 BARCODE_IN_USE). */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  barcode?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(ProductType)
  @IsOptional()
  type?: ProductType;

  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @IsNumber()
  costPrice: number;

  @IsNumber()
  sellingPrice: number;

  @IsNumber()
  mrp: number;

  @IsNumber()
  wholesalePrice: number;

  @IsEnum(GstRate)
  @IsOptional()
  gstRate?: GstRate;

  /** Cess percentage on the taxable amount (0-100); part of every POS line's tax. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  @IsOptional()
  cessRate?: number;

  @IsString()
  @IsOptional()
  hsnCode?: string;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  supplierId?: string;

  @IsString()
  @IsOptional()
  brandId?: string;

  @IsEnum(ProductUnit)
  unit: ProductUnit;

  @IsBoolean()
  @IsOptional()
  hasExpiry?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** PATCH payload: every field optional, same validation rules as create. */
export class UpdateProductDto extends PartialType(CreateProductDto) {}

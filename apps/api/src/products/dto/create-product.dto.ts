import { IsString, IsOptional, IsNumber, IsBoolean, IsEnum, MaxLength, Min, Max } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { ProductType, ProductStatus, ProductUnit, GstRate } from '@prisma/client';

/** Largest price a product column holds (`Decimal(10, 2)`). */
export const PRODUCT_MONEY_MAX = 99_999_999.99;

export class CreateProductDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  slug?: string;

  /** Unique per shop among live products; generated as `SKU-000001` when absent (roadmap 6.2). */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  sku?: string;

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

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(PRODUCT_MONEY_MAX)
  costPrice: number;

  /** Before GST: the POS adds GST and cess on top (contract §2). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(PRODUCT_MONEY_MAX)
  sellingPrice: number;

  /**
   * Maximum retail price, tax-inclusive (Legal Metrology, audit P1-2): at
   * least the selling price plus GST and cess for one unit
   * (`inclusiveUnitPrice`), else 400 PRICE_ABOVE_MRP. Omitted on create (or
   * `null` on update) it is that inclusive price.
   */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(PRODUCT_MONEY_MAX)
  @IsOptional()
  mrp?: number | null;

  /** The selling price when omitted on create. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(PRODUCT_MONEY_MAX)
  @IsOptional()
  wholesalePrice?: number;

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

  /** Low-stock alert level in the product unit (10 when absent; `Decimal(10, 3)`). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(9_999_999.999)
  @IsOptional()
  reorderPoint?: number;

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

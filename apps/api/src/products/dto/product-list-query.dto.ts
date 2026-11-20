import { Allow, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LimitOffsetQueryDto } from '../../common/pagination';

export const PRODUCT_STOCK_FILTERS = ['in', 'low', 'out'] as const;
export type ProductStockFilter = (typeof PRODUCT_STOCK_FILTERS)[number];

/**
 * `GET /products?q&limit&offset&categoryId&stock` (roadmap 6.2). `q` is
 * clamped by the service (a repeated `q` arrives as an array and reads as its
 * first value, contract §5), so it is whitelisted here without a type rule.
 * `stock` uses the dashboard's definitions: `out` = no stock, `low` = at or
 * below the product's reorder point, `in` = above it; services and digital
 * products are never "out".
 */
export class ProductListQueryDto extends LimitOffsetQueryDto {
  @Allow()
  q?: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  categoryId?: string;

  @IsOptional()
  @IsIn(PRODUCT_STOCK_FILTERS)
  stock?: ProductStockFilter;
}

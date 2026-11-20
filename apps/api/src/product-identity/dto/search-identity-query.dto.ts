import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `GET /product-identity/barcode/search?q=`: the barcode or SKU to resolve,
 * trimmed, 1..100 characters. Without this the query reached Prisma as
 * `undefined` and the route answered 500 (phase 4 gate).
 */
export class SearchIdentityQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  q: string;
}

import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The only fields `PATCH /shops/me` accepts. `ValidationPipe` rejects any
 * other property (forbidNonWhitelisted), so relation writes such as
 * `users`, `products` or `owner` never reach Prisma.
 */
export class UpdateShopProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  pincode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(191)
  email?: string;

  /** GSTIN as printed on invoices; an empty string clears it. */
  @IsOptional()
  @IsString()
  @Matches(/^$|^[0-9A-Z]{15}$/, { message: 'gstin must be 15 alphanumeric characters' })
  gstin?: string;
}

/** Shop columns a profile update may write; everything else on Shop is owner-, status- or system-managed. */
export const SHOP_PROFILE_FIELDS = ['name', 'address', 'city', 'state', 'pincode', 'phone', 'email'] as const;

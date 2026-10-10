import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateNested } from 'class-validator';

/** A reservation always expires (roadmap 3.8): between 30 seconds and 7 days. */
export const RESERVATION_MIN_TTL_SECONDS = 30;
export const RESERVATION_MAX_TTL_SECONDS = 7 * 24 * 3600;
import { ReservationSource } from '@prisma/client';

export class CreateReservationItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsNumber()
  @IsPositive()
  @Max(1_000_000)
  requestedQuantity: number;
}

export class CreateReservationDto {
  @IsEnum(ReservationSource)
  source: ReservationSource;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsInt()
  @Min(RESERVATION_MIN_TTL_SECONDS)
  @Max(RESERVATION_MAX_TTL_SECONDS)
  expiresInSeconds: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateReservationItemDto)
  items: CreateReservationItemDto[];
}

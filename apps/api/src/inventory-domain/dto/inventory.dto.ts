import { IsEnum, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { AdjustmentReason } from '@prisma/client';

/** InventoryItem.onHand is Decimal(12, 3). */
const MAX_QUANTITY = 999_999_999.999;

export class AdjustStockDto {
  @IsEnum(AdjustmentReason)
  reason: AdjustmentReason;

  /** Signed change; never 0, at most the column's range, 3 decimals (release audit S18). */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(-MAX_QUANTITY)
  @Max(MAX_QUANTITY)
  quantityChange: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  correlationId?: string;

  /** Replaying the same key returns the recorded adjustment instead of moving the stock twice. */
  @IsOptional()
  @IsString()
  @Length(8, 150)
  idempotencyKey?: string;
}

/** POST /inventory-domain/transfer: stock moves between two locations of the shop (release audit S2). */
export class TransferStockDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  fromLocationId: string;

  @IsString()
  toLocationId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(MAX_QUANTITY)
  quantity: number;

  /** One key per transfer the user means: a retry replays it. */
  @IsString()
  @Length(8, 150)
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateInventoryItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsNumber()
  onHand?: number;

  @IsOptional()
  @IsNumber()
  reorderPoint?: number;

  @IsOptional()
  @IsNumber()
  reorderQty?: number;

  @IsOptional()
  @IsNumber()
  safetyStock?: number;

  @IsOptional()
  @IsNumber()
  maxStock?: number;

  @IsOptional()
  @IsNumber()
  minStock?: number;
}

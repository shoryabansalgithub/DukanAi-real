import { IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { CountType, AdjustmentReason } from '@prisma/client';

export class CreateStockCountSessionDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsEnum(CountType)
  type: CountType;

  @IsOptional()
  @IsString()
  assignedToUserId?: string;
}

export class SubmitCountItemDto {
  @IsString()
  inventoryItemId: string;

  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  countedQuantity: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateAdjustmentRequestDto {
  @IsString()
  inventoryItemId: string;

  /** Manual requests only: a request raised from a count item takes its delta from the recorded variance. */
  @IsOptional()
  @IsNumber()
  @Min(-1_000_000)
  @Max(1_000_000)
  requestedQuantityDelta?: number;

  @IsEnum(AdjustmentReason)
  reason: AdjustmentReason;

  @IsOptional()
  @IsString()
  countItemId?: string;
}

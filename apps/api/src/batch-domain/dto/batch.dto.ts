import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsDateString, Max, MaxLength, Min } from 'class-validator';
import { BatchType } from '@prisma/client';

export class CreateBatchDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  batchNumber: string;

  @IsOptional()
  @IsString()
  supplierLotNumber?: string;

  @IsOptional()
  @IsDateString()
  mfgDate?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsEnum(BatchType)
  type: BatchType;
}

/**
 * Links received stock of a batch to a bin. BatchStock quantities are
 * maintained by batch receipts only (this route): they trace which batch
 * sits where, they never move `InventoryItem.onHand` (the stock engine does),
 * and a sale does not draw them down.
 */
export class AddBatchStockDto {
  @IsString()
  inventoryItemId: string;

  /** Positive: a batch receipt adds units (release audit S19). */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999_999_999.999)
  quantity: number;
}

/** POST /batches/:id/recall: the reason is recorded on the recall (release audit S19). */
export class RecallBatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

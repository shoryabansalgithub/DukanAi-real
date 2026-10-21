import { TenderType } from '@prisma/client';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateSupplierDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() phone: string;
  @IsString() @IsOptional() contactPerson?: string;
  @IsString() @IsOptional() email?: string;
  @IsString() @IsOptional() gstin?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() state?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999.99) @IsOptional() openingBalance?: number;
}

export class UpdateSupplierDto {
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() phone?: string;
  @IsString() @IsOptional() contactPerson?: string;
  @IsString() @IsOptional() email?: string;
  @IsString() @IsOptional() gstin?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() state?: string;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class RecordSupplierPaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99_999_999.99) amount: number;
  /** CASH leaves the drawer (CR CASH); anything else credits BANK. */
  @IsEnum(TenderType) @IsOptional() tender?: TenderType;
  @IsString() @IsOptional() @Length(1, 191) reference?: string;
  /** Required: one key per payment the user means (the web makes one per payment dialog); replaying it returns the recorded payment instead of paying twice. */
  @IsString() @Length(8, 191) idempotencyKey: string;
  @IsString() @IsOptional() @Length(1, 191) notes?: string;
}

import { IsBoolean, IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export const EXPENSE_PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Card'] as const;

/** Largest expense: a cash one moves a drawer, whose columns are Decimal(10, 2). */
export const MAX_EXPENSE_AMOUNT = 99_999_999.99;

export class CreateExpenseDto {
  @IsString() @IsNotEmpty() description: string;
  @IsString() @IsNotEmpty() category: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_EXPENSE_AMOUNT) amount: number;
  @IsBoolean() @IsOptional() isPaid?: boolean;
  /** How it was (or, while pending, will be) paid. */
  @IsIn(EXPENSE_PAYMENT_MODES) @IsOptional() paymentMode?: string;
  /** A real calendar day: `2026-02-30` is refused, not rolled over into March. */
  @IsDateString({ strict: true }) @IsOptional() expenseDate?: string;
}

export class UpdateExpenseDto {
  @IsString() @IsNotEmpty() @IsOptional() description?: string;
  @IsString() @IsNotEmpty() @IsOptional() category?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_EXPENSE_AMOUNT) @IsOptional() amount?: number;
  @IsBoolean() @IsOptional() isPaid?: boolean;
  @IsIn(EXPENSE_PAYMENT_MODES) @IsOptional() paymentMode?: string;
  @IsDateString({ strict: true }) @IsOptional() expenseDate?: string;
}

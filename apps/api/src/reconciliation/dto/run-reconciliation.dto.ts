import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** `POST /reconciliation/run`: the business day to reconcile, today in the shop's timezone when omitted. */
export class RunReconciliationDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  @ApiPropertyOptional({ example: '2026-10-05', description: 'Business day (shop timezone); defaults to today' })
  date?: string;
}

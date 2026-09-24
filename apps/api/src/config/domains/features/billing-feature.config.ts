import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsNumber, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

@Injectable()
@ConfigDomain({ owner: 'billing', feature: 'BillingFeatureConfig', version: '1.0.0', description: 'Billing module parameters' })
export class BillingFeatureConfig {
  @IsOptional()
  @IsNumber()
  /**
   * Interactive transaction budget for a sale/return/repayment. Sales of one
   * shop queue on the gapless number lock, so a burst of checkouts must fit
   * inside this window: 30 s covers several hundred queued checkouts.
   */
  @Transform(({ value }) => (value ? parseInt(value, 10) : 30000))
  @EnvVariable('BILLING_GATEWAY_TIMEOUT_MS')
  gatewayTimeoutMs: number = 30000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 50))
  @EnvVariable('BILLING_JITTER_DELAY_BASE_MS')
  jitterDelayBaseMs: number = 50;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 100))
  @EnvVariable('BILLING_JITTER_DELAY_RANDOM_MULTIPLIER')
  jitterDelayRandomMultiplier: number = 100;

  @IsOptional()
  @IsNumber()
  /** Time to wait for a pool connection before a checkout is rejected. */
  @Transform(({ value }) => (value ? parseInt(value, 10) : 15000))
  @EnvVariable('BILLING_TRANSACTION_MAX_WAIT_MS')
  transactionMaxWaitMs: number = 15000;

  /**
   * Largest discount (line or invoice, in percent of the eligible amount) a
   * CASHIER may apply on their own. Anything above needs a MANAGER/ADMIN/OWNER
   * to bill the invoice; the approver is stamped on Invoice.approvedBy.
   */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value === undefined || value === '' ? 10 : Number(value)))
  @EnvVariable('BILLING_CASHIER_MAX_DISCOUNT_PERCENT')
  cashierMaxDiscountPercent: number = 10;
}

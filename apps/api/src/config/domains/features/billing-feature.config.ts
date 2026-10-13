import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../../registry/registry.decorators';
import { IsInt, IsNumber, Max, Min } from 'class-validator';
import { IntegerFromEnv, NumberFromEnv } from '../../hydrate-from-env';

/**
 * Billing timeouts and the cashier discount authority (contract §2). Hydrated with `hydrateFromEnv`: an unset or blank variable keeps the
 * default, `0` is a value where the bound allows it, and anything that is not
 * a number (or is out of bounds) fails boot.
 */
@Injectable()
@ConfigDomain({ owner: 'billing', feature: 'BillingFeatureConfig', version: '1.1.0', description: 'Billing module parameters' })
export class BillingFeatureConfig {
  /** Interactive transaction budget for a sale/return/repayment. Sales of one shop queue on the gapless number lock, so a burst of checkouts must fit inside this window: 30 s covers several hundred queued checkouts. */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('BILLING_GATEWAY_TIMEOUT_MS')
  gatewayTimeoutMs: number = 30000;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('BILLING_JITTER_DELAY_BASE_MS')
  jitterDelayBaseMs: number = 50;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('BILLING_JITTER_DELAY_RANDOM_MULTIPLIER')
  jitterDelayRandomMultiplier: number = 100;

  /** Time to wait for a pool connection before a checkout is rejected. */
  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('BILLING_TRANSACTION_MAX_WAIT_MS')
  transactionMaxWaitMs: number = 15000;

  /** Largest discount (line or invoice, in percent of the eligible amount) a CASHIER may apply on their own; 0 means none, 100 means no limit. Anything above needs a MANAGER/ADMIN/OWNER to bill the invoice; the approver is stamped on Invoice.approvedBy. */
  @IsNumber()
  @Min(0)
  @Max(100)
  @NumberFromEnv()
  @EnvVariable('BILLING_CASHIER_MAX_DISCOUNT_PERCENT')
  cashierMaxDiscountPercent: number = 10;

  /** Largest custom (ad-hoc, free-priced) line amount a CASHIER may bill on their own, in rupees per line (roadmap 3.6, audit P2-23). 0 means cashiers cannot add custom lines; a larger line needs a MANAGER/ADMIN/OWNER to bill the invoice. */
  @IsNumber()
  @Min(0)
  @NumberFromEnv()
  @EnvVariable('BILLING_CASHIER_MAX_CUSTOM_LINE_AMOUNT')
  cashierMaxCustomLineAmount: number = 500;

  /** Largest sum of custom lines, in rupees per invoice, a CASHIER may bill on their own (audit B5): the per-line cap alone let four ₹500 lines through. 0 means cashiers cannot add custom lines; more needs a MANAGER/ADMIN/OWNER to bill the invoice (403 CUSTOM_LINE_REQUIRES_APPROVAL). */
  @IsNumber()
  @Min(0)
  @Max(99_999_999.99)
  @NumberFromEnv()
  @EnvVariable('BILLING_CASHIER_MAX_CUSTOM_TOTAL_AMOUNT')
  cashierMaxCustomTotalAmount: number = 1000;

  /** Largest refund, in rupees per return document, a CASHIER may give on their own (audit B6); a larger one is 403 RETURN_REQUIRES_APPROVAL and needs a MANAGER/ADMIN/OWNER. */
  @IsNumber()
  @Min(0)
  @Max(99_999_999.99)
  @NumberFromEnv()
  @EnvVariable('BILLING_CASHIER_MAX_REFUND_AMOUNT')
  cashierMaxRefundAmount: number = 2000;

  /** Oldest sale, in business days, a CASHIER may take a return against on their own (audit B6); an older one is 403 RETURN_REQUIRES_APPROVAL. 0 means same-day returns only. */
  @IsInt()
  @Min(0)
  @Max(3650)
  @IntegerFromEnv()
  @EnvVariable('BILLING_CASHIER_RETURN_WINDOW_DAYS')
  cashierReturnWindowDays: number = 7;
}

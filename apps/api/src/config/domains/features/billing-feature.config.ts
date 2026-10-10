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
}

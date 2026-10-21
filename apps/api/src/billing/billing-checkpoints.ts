import { Injectable } from '@nestjs/common';

/**
 * Named points inside the money transactions (sale, return, cancel,
 * repayment). Production behaviour is a no-op; the integration suite
 * overrides this provider to throw at a chosen point and proves that no
 * partial state survives (roadmap Phase 4, target 2: failure injection).
 */
export const BILLING_CHECKPOINTS = [
  'BEFORE_INVOICE',
  'AFTER_INVOICE',
  'BEFORE_PAYMENT',
  'AFTER_PAYMENT',
  'BEFORE_INVENTORY',
  'AFTER_INVENTORY',
  'BEFORE_CUSTOMER',
  'AFTER_CUSTOMER',
  'BEFORE_SHIFT',
  'AFTER_SHIFT',
  'BEFORE_LEDGER',
  'AFTER_LEDGER',
  'BEFORE_AUDIT',
  'AFTER_AUDIT',
  'EVENT_STAGING',
  'BEFORE_COMMIT',
] as const;

export type BillingCheckpoint = (typeof BILLING_CHECKPOINTS)[number];
export type BillingFlow = 'SALE' | 'RETURN' | 'CANCEL' | 'REPAYMENT';

@Injectable()
export class BillingCheckpoints {
  async reach(_point: BillingCheckpoint, _flow: BillingFlow): Promise<void> {
    /* no-op outside fault-injection tests */
  }
}

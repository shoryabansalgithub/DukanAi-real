import Decimal from 'decimal.js';
import type { PosCustomer } from '@/types';

/**
 * Customer credit projections shown in the POS. These are account figures,
 * not invoice math: the server re-checks them under a row lock on submit.
 * Decimal.js keeps the display free of binary float drift.
 */

export function availableCredit(customer: PosCustomer): number {
  return new Decimal(customer.creditLimit).minus(customer.outstandingBalance).toDecimalPlaces(2).toNumber();
}

export function projectedBalance(customer: PosCustomer, udharAmount: number): number {
  return new Decimal(customer.outstandingBalance).plus(udharAmount || 0).toDecimalPlaces(2).toNumber();
}

export function exceedsCreditLimit(customer: PosCustomer, udharAmount: number): boolean {
  return new Decimal(projectedBalance(customer, udharAmount)).greaterThan(customer.creditLimit);
}

/** finalTotal − Σ tender amounts (2 dp). Positive means still owed. */
export function remainingAfterTenders(finalTotal: number, amounts: number[]): number {
  return amounts
    .reduce((acc, amount) => acc.minus(Number.isFinite(amount) ? amount : 0), new Decimal(finalTotal))
    .toDecimalPlaces(2)
    .toNumber();
}

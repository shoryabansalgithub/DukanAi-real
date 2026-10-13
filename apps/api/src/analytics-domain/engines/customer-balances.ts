import { Prisma } from '@prisma/client';
import { toDecimal } from './invoice-sql';

export interface CustomerBalances {
  /** Σ of the positive balances: credit the customers still owe the shop. */
  outstanding: Prisma.Decimal;
  /** Σ of the negative balances, as a positive figure: money customers paid ahead (the shop owes it back or against future sales). */
  advances: Prisma.Decimal;
}

/**
 * Udhar position of a shop's live customers (release audit L10). An advance
 * is not a due: summing the signed balances let one customer's ₹500 advance
 * hide another customer's ₹500 debt, so "Outstanding udhar" only adds what is
 * owed and advances are their own figure.
 */
export async function customerBalances(prisma: { $queryRaw: Prisma.TransactionClient['$queryRaw'] }, shopId: string): Promise<CustomerBalances> {
  const rows = await prisma.$queryRaw<Array<{ outstanding: unknown; advances: unknown }>>`
    SELECT
      COALESCE(SUM(CASE WHEN c.outstandingBalance > 0 THEN c.outstandingBalance ELSE 0 END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN c.outstandingBalance < 0 THEN -c.outstandingBalance ELSE 0 END), 0) AS advances
    FROM Customer c
    WHERE c.shopId = ${shopId} AND c.isDeleted = false
  `;
  return { outstanding: toDecimal(rows[0]?.outstanding), advances: toDecimal(rows[0]?.advances) };
}

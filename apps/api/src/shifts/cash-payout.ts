import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Takes money out of a cash drawer (an expense paid from the till, a supplier
 * paid in cash). Locks the actor's open shift first, which is the canonical
 * lock order every money flow shares (Shift before Customer/Supplier before
 * the ledger balances), then lowers its expected cash and raises its payouts,
 * so the close-of-shift variance and the reconciliation's shift check both
 * count the payout. Returns the shift's id to store on the payout document,
 * or null when the actor has no open shift (the payout is then outside any
 * drawer, like a cash sale billed without a shift).
 */
export async function lockShiftForCashPayout(tx: Tx, shopId: string, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM Shift WHERE shopId = ${shopId} AND openedById = ${userId} AND status = 'OPEN' AND isDeleted = false ORDER BY openedAt DESC LIMIT 1 FOR UPDATE
  `;
  return rows[0]?.id ?? null;
}

/** Applies a payout of `amount` to the shift `lockShiftForCashPayout` returned (a no-op without one). */
export async function applyCashPayout(tx: Tx, shiftId: string | null, amount: Prisma.Decimal): Promise<void> {
  if (!shiftId || !amount.greaterThan(0)) return;
  await tx.shift.update({
    where: { id: shiftId },
    data: { expectedCash: { decrement: amount }, cashPayouts: { increment: amount } },
  });
}

/** Undoes a payout (an expense deleted or edited while its shift is still open). */
export async function reverseCashPayout(tx: Tx, shiftId: string | null, amount: Prisma.Decimal): Promise<void> {
  if (!shiftId || !amount.greaterThan(0)) return;
  await tx.shift.update({
    where: { id: shiftId },
    data: { expectedCash: { increment: amount }, cashPayouts: { decrement: amount } },
  });
}

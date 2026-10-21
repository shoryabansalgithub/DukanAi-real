import { Expense, LedgerAccount, Prisma } from '@prisma/client';

/**
 * How an expense reaches the books and the drawer (release audit L6). Pure:
 * `ExpensesService` writes by these rules and the reconciliation checks by
 * the same ones.
 */

/** The mode a paid expense defaults to, and the one that takes cash out of a drawer. */
export const CASH_MODE = 'Cash';

/** Ledger source types of an expense: the first posting (the expense id), then one adjustment per later change. */
export const EXPENSE_SOURCES = { posted: 'EXPENSE', adjusted: 'EXPENSE_ADJUSTMENT' } as const;

/** The posting key of an expense's n-th adjustment (`<id>:<n>`, n from 1). */
export const expenseAdjustmentSourceId = (expenseId: string, n: number) => `${expenseId}:${n}`;

/** The expense a posting of the family belongs to (`<id>` or `<id>:<n>`). */
export const expenseIdOfSource = (sourceId: string) => sourceId.split(':')[0];

export type ExpenseBooks = Pick<Expense, 'amount' | 'isPaid' | 'paymentMode' | 'isDeleted'>;

const ZERO = new Prisma.Decimal(0);

/** The account a paid expense leaves: the drawer for cash, the bank for UPI, card and transfers. */
export function expenseCreditAccount(paymentMode: string | null | undefined): LedgerAccount {
  return (paymentMode ?? CASH_MODE) === CASH_MODE ? LedgerAccount.CASH : LedgerAccount.BANK;
}

/**
 * What the ledger must hold for an expense, as the signed movement of each
 * account (debit minus credit): a live paid expense is DR EXPENSES / CR CASH
 * (cash) or CR BANK (every other mode); a pending or deleted one is nothing.
 */
export function expenseLedgerState(expense: ExpenseBooks): Map<LedgerAccount, Prisma.Decimal> {
  const state = new Map<LedgerAccount, Prisma.Decimal>();
  if (expense.isDeleted || !expense.isPaid || !expense.amount.greaterThan(0)) return state;
  const amount = expense.amount.toDecimalPlaces(2);
  state.set(LedgerAccount.EXPENSES, amount);
  state.set(expenseCreditAccount(expense.paymentMode), amount.neg());
  return state;
}

/** Cash this expense takes out of a drawer: a live paid cash expense's amount, else 0. */
export function expenseCashOut(expense: ExpenseBooks): Prisma.Decimal {
  if (expense.isDeleted || !expense.isPaid || (expense.paymentMode ?? CASH_MODE) !== CASH_MODE) return ZERO;
  return expense.amount.toDecimalPlaces(2);
}

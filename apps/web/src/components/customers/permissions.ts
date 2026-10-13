import { AUTH_DISABLED } from '@/lib/auth-bypass';

/**
 * The API's role sets (`apps/api/src/auth/role-sets.ts`), mirrored so a page
 * shows only the actions the API would accept (audit W12). The bypass system
 * user is an OWNER. SUPER_ADMIN is listed only where the API lists it.
 */
const ROLE_RANK: Readonly<Record<string, number>> = {
  SUPER_ADMIN: 100,
  OWNER: 90,
  ADMIN: 80,
  MANAGER: 70,
  CASHIER: 60,
  VIEWER: 50,
};

/** `MANAGEMENT_ROLES`: stock, invoices, approvals, notifications read-all, OCR. */
const MANAGEMENT_ROLES = new Set(['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);
/**
 * `FINANCE_ROLES` (= MANAGEMENT_ROLES): cost prices, profit and margin, stock
 * at cost, supplier balances and purchasing, expenses, Reports. The API
 * refuses those pages' reads (403) and leaves the cost and profit fields out
 * of every other answer to a CASHIER or VIEWER.
 */
const FINANCE_ROLES = MANAGEMENT_ROLES;
/** `POS_ROLES`: everything a cashier does at the counter, plus management. */
const POS_ROLES = new Set(['CASHIER', 'MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);

/** The effective role of the signed-in user, upper-cased; the auth bypass is the OWNER. */
export function effectiveRole(role: string | null | undefined): string | null {
  if (AUTH_DISABLED) return 'OWNER';
  return role ? role.toUpperCase() : null;
}

function inSet(set: Set<string>, role: string | null | undefined): boolean {
  const effective = effectiveRole(role);
  return !!effective && set.has(effective);
}

/** Contract §4: `DELETE /customers/:id` is MANAGER and above. */
export function canDeleteCustomers(role: string | null | undefined): boolean {
  return inSet(MANAGEMENT_ROLES, role);
}

/** `POST /customers`, `PATCH /customers/:id`, `POST /customers/:id/payments` are POS_ROLES: never a VIEWER. */
export function canWriteCustomers(role: string | null | undefined): boolean {
  return inSet(POS_ROLES, role);
}

/** A credit limit is set or changed by MANAGER and above only (`CREDIT_LIMIT_REQUIRES_MANAGER`). */
export function canSetCreditLimit(role: string | null | undefined): boolean {
  return inSet(MANAGEMENT_ROLES, role);
}

/** Sales returns (`POST /billing/returns`) are POS_ROLES. */
export function canReturnInvoices(role: string | null | undefined): boolean {
  return inSet(POS_ROLES, role);
}

/** The POS bills for POS_ROLES; a VIEWER has no use for the link. */
export function canUsePos(role: string | null | undefined): boolean {
  return inSet(POS_ROLES, role);
}

/** `MANAGEMENT_ROLES`: e.g. `PATCH /notifications/read-all`, `POST /ocr/scan-bill`. */
export function isManagement(role: string | null | undefined): boolean {
  return inSet(MANAGEMENT_ROLES, role);
}

/** True when `actor` ranks strictly above `subject` (the API's `outranks`). */
export function outranks(actor: string | null | undefined, subject: string | null | undefined): boolean {
  const a = effectiveRole(actor);
  const s = subject ? subject.toUpperCase() : null;
  if (!a || !s) return false;
  return (ROLE_RANK[a] ?? 0) > (ROLE_RANK[s] ?? Number.POSITIVE_INFINITY);
}

/** Cost, profit, stock value, suppliers, expenses and Reports: owners, admins and managers only. */
export function canSeeFinancials(role: string | null | undefined): boolean {
  return inSet(FINANCE_ROLES, role);
}

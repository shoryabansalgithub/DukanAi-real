import { Role } from '@prisma/client';

/**
 * The role sets the authorization policy is written in (roadmap phase 1.2).
 * Spread them into `@Roles(...)`: `@Roles(...MANAGEMENT_ROLES)`.
 */

/** Owner-level administration: destructive or shop-wide operations. */
export const ADMIN_ROLES: readonly Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN];

/** Stock, ledger, purchasing, approvals, suppliers, warehouses, webhooks, events, invoices, expenses. */
export const MANAGEMENT_ROLES: readonly Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

/** Everything a cashier does at the counter, plus management. */
export const POS_ROLES: readonly Role[] = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER];

/**
 * Authority order of the roles, highest first. A user may only grant, suspend
 * or delete a role that ranks strictly below their own (`outranks`).
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  [Role.SUPER_ADMIN]: 100,
  [Role.OWNER]: 90,
  [Role.ADMIN]: 80,
  [Role.MANAGER]: 70,
  [Role.CASHIER]: 60,
  [Role.VIEWER]: 50,
};

/** True when `actor` ranks strictly above `subject`. */
export function outranks(actor: Role, subject: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[subject];
}

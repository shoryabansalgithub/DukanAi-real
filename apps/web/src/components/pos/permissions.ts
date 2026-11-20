import { AUTH_DISABLED } from '@/lib/auth-bypass';

/** Contract §2: `POST /billing/calculate|invoice|returns` are POS_ROLES; a VIEWER may look at the POS but never bill. */
const POS_ROLES = new Set(['CASHIER', 'MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);

export function canBill(role: string | null | undefined): boolean {
  if (AUTH_DISABLED) return true; // the bypass system user is an OWNER
  return !!role && POS_ROLES.has(role.toUpperCase());
}

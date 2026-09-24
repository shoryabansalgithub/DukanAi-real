import { AUTH_DISABLED } from '@/lib/auth-bypass';

/** Contract §4: `DELETE /customers/:id` is MANAGER and above. */
const DELETE_ROLES = new Set(['MANAGER', 'ADMIN', 'OWNER', 'SUPER_ADMIN']);

export function canDeleteCustomers(role: string | null | undefined): boolean {
  if (AUTH_DISABLED) return true; // the bypass system user is an OWNER
  return !!role && DELETE_ROLES.has(role.toUpperCase());
}

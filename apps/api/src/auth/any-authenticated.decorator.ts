import { SetMetadata } from '@nestjs/common';

export const ANY_AUTHENTICATED_KEY = 'anyAuthenticated';

/**
 * Marks a state-changing handler that every signed-in user may call because
 * it only touches the caller's own data (revoking one's own session, marking
 * one's own notifications read). `RolesGuard` refuses any other non-GET
 * handler that carries no `@Roles(...)`.
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED_KEY, true);

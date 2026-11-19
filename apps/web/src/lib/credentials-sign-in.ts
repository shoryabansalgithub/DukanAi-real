import type { SignInResponse } from 'next-auth/react';

/**
 * NextAuth checks a CSRF token on every credentials sign-in. The token lives in
 * a cookie, and every `/api/auth/*` answer to a browser without one sets a new
 * one: on a first visit the session poll, the client's error log and the
 * token fetch can race, and a late answer replaces the cookie the token was
 * taken from. The server then refuses the sign-in without calling authorize
 * and answers `.../signin?csrf=true`, a URL with no `error` parameter, so
 * `signIn(..., { redirect: false })` reports `ok` and the page went on to
 * /dashboard without a session (and the proxy sent it back to /login).
 *
 * A refusal checked no password, so trying again costs no login attempt; by
 * then the browser holds one stable cookie and the fresh token matches it.
 */
export const CSRF_REJECTED = 'CsrfRejected';

const MAX_ATTEMPTS = 3;

export function isCsrfRejection(result: SignInResponse | undefined): boolean {
  if (!result?.url) return false;
  try {
    return new URL(result.url, 'http://localhost').searchParams.get('csrf') === 'true';
  } catch {
    return false;
  }
}

/**
 * Runs `attempt` (a `signIn('credentials', { redirect: false, ... })`) until
 * the server stops refusing its CSRF token. A sign-in still refused after
 * the last attempt comes back as a failure, `error: CSRF_REJECTED`, never as
 * a success.
 */
export async function retryCsrfRejection(
  attempt: () => Promise<SignInResponse | undefined>
): Promise<SignInResponse | undefined> {
  for (let n = 1; ; n += 1) {
    const result = await attempt();
    if (!isCsrfRejection(result)) return result;
    if (n >= MAX_ATTEMPTS) return { error: CSRF_REJECTED, status: 403, ok: false, url: null };
  }
}

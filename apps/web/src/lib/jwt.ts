/**
 * Dependency-free JWT `exp` reader. Works in the browser, Node and the Edge
 * runtime (only `atob` is required). It does NOT verify the signature; the API
 * remains the authority on token validity. We only need the expiry to decide
 * when to refresh proactively.
 */
export function decodeJwtExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

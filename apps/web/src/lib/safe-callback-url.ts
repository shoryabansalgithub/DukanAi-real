/**
 * Where to send the user after sign-in (roadmap 6.4). The value comes from
 * the `callbackUrl` query parameter, which anyone can forge in a link, so it
 * is parsed against the app's own origin and kept only when it stays there:
 * `https://evil.example`, `//evil.example`, `/\evil.example` (which browsers
 * read as protocol-relative) and `javascript:` all fall back to the default.
 * The result is always a same-origin path, never an absolute URL.
 */
export const DEFAULT_CALLBACK_URL = '/dashboard';

/** Pages a sign-in must never bounce back to (they would loop). */
const AUTH_PAGES = new Set(['/login', '/register']);

export function sanitizeCallbackUrl(raw: string | null | undefined, origin: string, fallback = DEFAULT_CALLBACK_URL): string {
  if (!raw || raw.length > 2048) return fallback;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  if (!url.pathname.startsWith('/') || AUTH_PAGES.has(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

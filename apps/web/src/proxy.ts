import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { AUTH_BYPASS_REFUSED, AUTH_DISABLED } from '@/lib/auth-bypass';

/**
 * Route gate and per-request security policy (roadmap 6.4). Next.js 16 runs this as the
 * `proxy` (the former middleware convention) on the Node.js runtime for every matched request.
 *
 * Every app page needs a valid NextAuth session: the JWT inside the cookie is
 * verified with `getToken` (signature, expiry, and no refresh failure), not
 * merely present. The API stays the authority on the access token it carries;
 * this check stops unauthenticated or stale browsers from rendering protected
 * shells and bounces them to /login with a same-origin `callbackUrl`.
 *
 * The Content Security Policy is built here because it carries a fresh
 * script nonce: Next.js reads it from the request header and stamps its own
 * inline scripts, so `script-src` needs no 'unsafe-inline'. The static
 * headers (HSTS, frame options, referrer, permissions) live in next.config.js.
 *
 * Static assets (`/_next/*`, `favicon.ico`, anything with a file extension)
 * and NextAuth's own routes are excluded by the matcher below.
 */
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];
const IS_DEV = process.env.NODE_ENV === 'development';

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function apiOrigin(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002/api').origin;
  } catch {
    return null;
  }
}

/** A 128-bit nonce, base64 (the Web Crypto API is available in the edge and node runtimes). */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildCsp(nonce: string): string {
  const api = apiOrigin();
  const connect = ["'self'", api, IS_DEV ? 'ws: wss:' : null].filter(Boolean).join(' ');
  // Development: React Refresh evaluates code; production never does.
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", IS_DEV ? "'unsafe-eval'" : null].filter(Boolean).join(' ');
  return [
    `default-src 'self'`,
    `script-src ${script}`,
    // Tailwind runtime classes are static CSS; framer-motion and a few components set inline style attributes.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src ${connect}`,
    `worker-src 'self' blob:`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    IS_DEV ? null : 'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');
}

function withSecurityPolicy(req: NextRequest, response?: NextResponse): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce);
  // The request copy is what Next.js reads to nonce its inline scripts; the response copy is what the browser enforces.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const res = response ?? NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export async function proxy(req: NextRequest) {
  if (AUTH_BYPASS_REFUSED) {
    // A production server started with NEXT_PUBLIC_AUTH_DISABLED (next.config.js already refuses to boot).
    return new NextResponse('Authentication bypass is not permitted in production.', { status: 503 });
  }

  if (AUTH_DISABLED) {
    return withSecurityPolicy(req);
  }

  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return withSecurityPolicy(req);
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token && !token.error) {
    return withSecurityPolicy(req);
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('callbackUrl', `${pathname}${search}`);
  return withSecurityPolicy(req, NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    // Everything except NextAuth routes, the liveness probe, Next internals and files with an extension.
    '/((?!api/auth|api/health|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};

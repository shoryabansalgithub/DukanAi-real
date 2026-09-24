import { NextRequest, NextResponse } from 'next/server';
import { AUTH_DISABLED } from '@/lib/auth-bypass';

/**
 * Route gate: every app page requires a NextAuth session cookie, except the
 * auth pages and NextAuth's own API routes. The API stays the authority on
 * whether the token inside the cookie is valid; this check only stops
 * unauthenticated browsers from rendering protected shells.
 *
 * Static assets (`/_next/*`, `favicon.ico`, anything with a file extension)
 * are excluded by the matcher below.
 */
const PUBLIC_PATHS = ['/login', '/register'];

// NextAuth v4 cookie names. Large JWTs are chunked into `<name>.0`, `<name>.1`,
// so a prefix match is used rather than an exact lookup.
const SESSION_COOKIE_PREFIXES = ['__Secure-next-auth.session-token', 'next-auth.session-token'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies
    .getAll()
    .some((cookie) =>
      SESSION_COOKIE_PREFIXES.some(
        (prefix) => (cookie.name === prefix || cookie.name.startsWith(`${prefix}.`)) && cookie.value.length > 0,
      ),
    );
}

export function middleware(req: NextRequest) {
  if (AUTH_DISABLED) {
    return NextResponse.next();
  }

  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname) || hasSessionCookie(req)) {
    return NextResponse.next();
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('callbackUrl', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except NextAuth routes, Next internals and files with an extension.
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};

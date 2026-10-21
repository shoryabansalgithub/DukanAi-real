const path = require('node:path');

/**
 * Roadmap 6.4: the auth bypass never ships. `next build` and `next start` both
 * load this file with NODE_ENV=production, so a production bundle or server
 * with NEXT_PUBLIC_AUTH_DISABLED on refuses to start here, before any page is
 * built or served (src/lib/auth-bypass.ts also compiles the flag to false in
 * production, and the proxy answers 503 as the last line).
 */
const BYPASS_ON = ['1', 'true', 'yes', 'on'].includes((process.env.NEXT_PUBLIC_AUTH_DISABLED ?? '').trim().toLowerCase());
if (process.env.NODE_ENV === 'production' && BYPASS_ON) {
  throw new Error(
    'NEXT_PUBLIC_AUTH_DISABLED is set while NODE_ENV=production. The auth bypass is a development/test aid; unset it before building or starting a production web server.',
  );
}

/**
 * Static security headers on every response (roadmap 6.4). The Content
 * Security Policy is per request (it carries a script nonce) and lives in
 * src/proxy.ts; everything that does not depend on the request is here.
 * The camera is allowed for the page itself (Smart Capture); nothing else may
 * use a powerful feature, and no page may be framed.
 */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/**
 * Container builds (roadmap 7.3, apps/web/Dockerfile) set NEXT_STANDALONE=true
 * so `next build` emits .next/standalone, a self-contained server with only the
 * traced dependencies. Not the default: `next start` refuses a standalone
 * build, and the Lighthouse / smoke runs use `next build` + `next start`.
 * The tracing root is the monorepo root so workspace packages
 * (@dukaanai/invoice-math) and hoisted node_modules are included.
 */
const STANDALONE = ['1', 'true', 'yes', 'on'].includes((process.env.NEXT_STANDALONE ?? '').trim().toLowerCase());

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(STANDALONE ? { output: 'standalone' } : {}),
  outputFileTracingRoot: path.join(__dirname, '../../'),
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }];
  },
};

module.exports = nextConfig;

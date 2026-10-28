/**
 * The public marketing surface (`src/app/(marketing)`). The proxy lets these
 * paths through without a session; everything else is the app and needs one.
 * A new top-level marketing section is added here AND to the sitemap
 * (`src/marketing/registry.ts`), or logged-out visitors and crawlers are sent
 * to /login. Every section also mounts `MarketingMissingPage` as its
 * catch-all, or an unknown address under it renders the app shell's 404.
 */
export const MARKETING_SECTIONS = [
  '/features',
  '/blog',
  '/faq',
  '/alternatives',
  '/glossary',
] as const;

/** Generated images: every page's social card (`/og/...`); the raster logo the Organization schema names is `/apple-icon` alone. */
const MARKETING_ASSETS = ['/og'];

export function isMarketingPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/apple-icon') return true;
  return [...MARKETING_SECTIONS, ...MARKETING_ASSETS].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

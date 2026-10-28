/**
 * The public marketing surface (`src/app/(marketing)`). The proxy lets these
 * paths through without a session; everything else is the app and needs one.
 * A new top-level marketing section is added here AND to the sitemap
 * (`src/marketing/registry.ts`), or logged-out visitors and crawlers are sent
 * to /login.
 */
export const MARKETING_SECTIONS = ['/features', '/blog', '/faq', '/alternatives', '/glossary'] as const;

/** Generated images: every page's social card (`/og/...`) and the raster logo the Organization schema names. */
const MARKETING_ASSETS = ['/og', '/apple-icon'];

export function isMarketingPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return [...MARKETING_SECTIONS, ...MARKETING_ASSETS].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

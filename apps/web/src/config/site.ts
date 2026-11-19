/**
 * The public address of the marketing site: canonical URLs, the sitemap,
 * robots.txt, Open Graph tags and llms.txt are all built from it.
 *
 * `SITE_URL` is read on the server at run time (one image serves every
 * environment, roadmap 9.9). Unset, it is the Vercel project's production
 * domain (VERCEL_PROJECT_PRODUCTION_URL, so a custom domain added on Vercel
 * is picked up by itself); set SITE_URL to pin another. The rules live in `site-rules.js`, which next.config.js
 * also checks so a bad value fails the build instead of the running site.
 */
import { parseSiteIndexable, parseSiteUrl } from './site-rules';

export const SITE_NAME = 'DukaanAI';

export function siteUrl(): string {
  return parseSiteUrl(process.env.SITE_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL);
}

/**
 * Whether search engines and AI crawlers may index the site. On unless
 * `SITE_INDEXABLE=false` (staging), and off by itself on a Vercel preview
 * (`VERCEL_ENV` set to anything but "production"), so production ranks
 * without anyone setting a flag. Off: robots.txt is `Disallow: /`, every page
 * is noindex and neither the sitemap nor llms.txt is published.
 */
export function siteIndexable(): boolean {
  return parseSiteIndexable(process.env.SITE_INDEXABLE, process.env.VERCEL_ENV);
}

/**
 * `path` ("/features") as an absolute URL on the site. The home page is the
 * bare origin, the form Next.js renders as its canonical, so the sitemap,
 * llms.txt and JSON-LD all name it the same way.
 */
export function absoluteUrl(path: string): string {
  return path === '/' ? siteUrl() : `${siteUrl()}${path}`;
}

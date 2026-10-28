/**
 * The public address of the marketing site: canonical URLs, the sitemap,
 * robots.txt, Open Graph tags and llms.txt are all built from it.
 *
 * `SITE_URL` is read on the server at run time (one image serves every
 * environment, roadmap 9.9). Unset, it is the production Vercel address;
 * when the custom domain arrives, set SITE_URL to it and every canonical
 * moves with it.
 */
export const DEFAULT_SITE_URL = 'https://dukan-ai-chi.vercel.app';

export const SITE_NAME = 'DukaanAI';

export function siteUrl(): string {
  const raw = (process.env.SITE_URL ?? '').trim();
  if (!raw) return DEFAULT_SITE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not an absolute URL: "${raw}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`SITE_URL must be an http(s) URL: "${raw}"`);
  }
  return parsed.origin;
}

/**
 * `path` ("/features") as an absolute URL on the site. The home page is the
 * bare origin, the form Next.js renders as its canonical, so the sitemap,
 * llms.txt and JSON-LD all name it the same way.
 */
export function absoluteUrl(path: string): string {
  return path === '/' ? siteUrl() : `${siteUrl()}${path}`;
}

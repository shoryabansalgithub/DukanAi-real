/**
 * The rules for SITE_URL and SITE_INDEXABLE, in one place for both readers:
 * next.config.js (CommonJS, so this file is too) checks them when `next
 * build`, `next start` or `next dev` loads it, and src/config/site.ts reads
 * them per request. Every page renders per request, so without the build-time
 * check a bad value passed `next build`, Vercel promoted the deployment, and
 * every server start then refused to run (POS included). Now Vercel's build
 * fails and the previous deployment keeps serving. The standalone image never
 * loads next.config.js; src/instrumentation.ts checks it there at start.
 */

/** The production address until a custom domain is set in SITE_URL. */
const DEFAULT_SITE_URL = 'https://dukan-ai-chi.vercel.app';

/**
 * SITE_URL as an origin (`https://dukaanai.in`). Blank is the default; a bare
 * host (`dukaanai.in`, what people type into a dashboard) means https. A
 * value with a path, query, credentials or another scheme is refused: every
 * canonical URL, the sitemap and Open Graph tags are built on it.
 * @param {string | undefined} value
 * @returns {string}
 */
function parseSiteUrl(value) {
  const raw = (value ?? '').trim();
  if (!raw) return DEFAULT_SITE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`SITE_URL is not a web address: "${raw}" (example: https://dukaanai.in)`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`SITE_URL must be an http(s) address: "${raw}"`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `SITE_URL must be the site's origin only, such as https://dukaanai.in: "${raw}"`
    );
  }
  return parsed.origin;
}

/**
 * Whether search engines and AI crawlers may index the site: on unless
 * SITE_INDEXABLE=false (staging), and off by itself on a Vercel preview
 * (VERCEL_ENV set to anything but "production").
 * @param {string | undefined} value SITE_INDEXABLE
 * @param {string | undefined} vercelEnv VERCEL_ENV
 * @returns {boolean}
 */
function parseSiteIndexable(value, vercelEnv) {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    throw new Error(`SITE_INDEXABLE must be "true" or "false": "${value}"`);
  }
  if (raw === 'false') return false;
  const env = (vercelEnv ?? '').trim();
  return env === '' || env === 'production';
}

module.exports = { parseSiteUrl, parseSiteIndexable };

import type { MetadataRoute } from 'next';
import { absoluteUrl, siteIndexable } from '@/config/site';

export const dynamic = 'force-dynamic';

/**
 * Crawlers, search and AI alike, may read every public page; the signed-in
 * application is closed to them (it only answers with a redirect to /login,
 * and every app page is noindex as well). The sign-in pages stay crawlable so
 * their noindex is seen. A site that may not be indexed (staging, a Vercel
 * preview) closes everything and names no sitemap.
 */
const APP_PATHS = [
  '/dashboard',
  '/billing',
  '/customers',
  '/products',
  '/inventory',
  '/invoices',
  '/analytics',
  '/ai-scanner',
  '/smart-capture',
  '/employees',
  '/expenses',
  '/shifts',
  '/suppliers',
  '/notifications',
  '/settings',
  '/api/',
];

export default function robots(): MetadataRoute.Robots {
  if (!siteIndexable()) return { rules: [{ userAgent: '*', disallow: '/' }] };
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: APP_PATHS }],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}

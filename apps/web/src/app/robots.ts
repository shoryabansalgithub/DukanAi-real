import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/config/site';

export const dynamic = 'force-dynamic';

/**
 * Crawlers, search and AI alike, may read every public page; the signed-in
 * application is closed to them (it only answers with a redirect to /login,
 * and every app page is noindex as well). The sign-in pages stay crawlable so
 * their noindex is seen.
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
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: APP_PATHS }],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}

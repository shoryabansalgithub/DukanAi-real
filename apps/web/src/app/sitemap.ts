import type { MetadataRoute } from 'next';
import { absoluteUrl, siteIndexable } from '@/config/site';
import { MARKETING_PAGES } from '@/marketing/registry';

/** Built per request so SITE_URL is the runtime value (one image, any environment). */
export const dynamic = 'force-dynamic';

const PRIORITY: Record<string, number> = {
  home: 1,
  features: 0.9,
  alternatives: 0.8,
  faq: 0.7,
  blog: 0.7,
  glossary: 0.6,
};

export default function sitemap(): MetadataRoute.Sitemap {
  if (!siteIndexable()) return [];
  return MARKETING_PAGES.map((page) => ({
    url: absoluteUrl(page.path),
    lastModified: page.updated,
    changeFrequency: page.section === 'blog' && page.path !== '/blog' ? 'monthly' : 'weekly',
    priority: PRIORITY[page.section],
  }));
}

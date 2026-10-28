import type { Metadata } from 'next';
import { SITE_NAME, siteIndexable } from '@/config/site';
import type { MarketingPage } from './content/types';
import { markdownPath, ogImagePath } from './registry';

/**
 * Title, description, canonical, the Markdown twin and the social card tags
 * of a public page. Relative URLs become absolute on SITE_URL through the
 * root layout's `metadataBase`. Call it per request (`generateMetadata`):
 * whether the page may be indexed is a run-time setting.
 */
export function pageMetadata(page: MarketingPage): Metadata {
  const article = page.section === 'blog' && Boolean(page.published);
  const image = { url: ogImagePath(page.path), width: 1200, height: 630, alt: page.h1 };
  return {
    title: { absolute: page.title },
    description: page.description,
    alternates: { canonical: page.path, types: { 'text/markdown': markdownPath(page.path) } },
    robots: siteIndexable() ? { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } : { index: false, follow: false },
    openGraph: {
      type: article ? 'article' : 'website',
      url: page.path,
      siteName: SITE_NAME,
      locale: 'en_IN',
      title: page.title,
      description: page.description,
      images: [image],
      ...(article ? { publishedTime: page.published, modifiedTime: page.updated } : {}),
    },
    twitter: { card: 'summary_large_image', title: page.title, description: page.description, images: [image] },
  };
}

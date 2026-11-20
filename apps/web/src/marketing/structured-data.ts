import { absoluteUrl, SITE_NAME, siteUrl } from '@/config/site';
import { plainText, slugify } from './markdown';
import type { Faq, MarketingPage } from './content/types';
import type { GlossaryTerm } from './content/glossary';
import { FEATURE_PAGES } from './content/features';
import { ogImagePath, pageByPath } from './registry';

/** schema.org objects for the marketing pages, rendered by `<JsonLd>`. */
type Thing = Record<string, unknown>;

const ORG_ID = () => `${siteUrl()}/#organization`;
const SITE_ID = () => `${siteUrl()}/#website`;

export function organization(): Thing {
  return {
    '@type': 'Organization',
    '@id': ORG_ID(),
    name: SITE_NAME,
    url: absoluteUrl('/'),
    logo: { '@type': 'ImageObject', url: absoluteUrl('/apple-icon'), width: 180, height: 180 },
    description: 'Billing and shop-management software for Indian kirana and retail stores.',
    areaServed: { '@type': 'Country', name: 'India' },
  };
}

export function website(): Thing {
  return {
    '@type': 'WebSite',
    '@id': SITE_ID(),
    name: SITE_NAME,
    url: absoluteUrl('/'),
    inLanguage: 'en-IN',
    publisher: { '@id': ORG_ID() },
  };
}

export function softwareApplication(): Thing {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${siteUrl()}/#software`,
    name: SITE_NAME,
    url: absoluteUrl('/'),
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Point of sale and billing',
    operatingSystem: 'Any (web browser)',
    inLanguage: 'en-IN',
    description:
      'GST billing, udhar (credit) tracking, inventory with low-stock and expiry alerts, cash-drawer shifts, staff roles and an AI bill scanner for Indian kirana and retail stores.',
    featureList: FEATURE_PAGES.map((page) => page.label),
    publisher: { '@id': ORG_ID() },
  };
}

export function breadcrumbs(page: MarketingPage): Thing {
  const trail: MarketingPage[] = [];
  const segments = page.path.split('/').filter(Boolean);
  for (let i = 1; i <= segments.length; i += 1) {
    const ancestor = pageByPath(`/${segments.slice(0, i).join('/')}`);
    if (ancestor) trail.push(ancestor);
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [{ label: 'Home', path: '/' }, ...trail].map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      item: absoluteUrl(crumb.path),
    })),
  };
}

export function faqPage(faqs: Faq[], path: string): Thing {
  return {
    '@type': 'FAQPage',
    '@id': `${absoluteUrl(path)}#faq`,
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: plainText(faq.a) },
    })),
  };
}

export function webPage(page: MarketingPage): Thing {
  return {
    '@type': 'WebPage',
    '@id': absoluteUrl(page.path),
    url: absoluteUrl(page.path),
    name: page.title,
    description: page.description,
    inLanguage: 'en-IN',
    isPartOf: { '@id': SITE_ID() },
    dateModified: page.updated,
  };
}

export function blogPosting(page: MarketingPage): Thing {
  return {
    '@type': 'BlogPosting',
    '@id': `${absoluteUrl(page.path)}#article`,
    headline: page.h1,
    description: page.description,
    url: absoluteUrl(page.path),
    mainEntityOfPage: absoluteUrl(page.path),
    image: absoluteUrl(ogImagePath(page.path)),
    datePublished: page.published,
    dateModified: page.updated,
    inLanguage: 'en-IN',
    author: { '@id': ORG_ID() },
    publisher: { '@id': ORG_ID() },
  };
}

export function definedTermSet(terms: GlossaryTerm[], path: string): Thing {
  const url = absoluteUrl(path);
  return {
    '@type': 'DefinedTermSet',
    '@id': `${url}#terms`,
    name: 'Kirana and GST glossary',
    url,
    hasDefinedTerm: terms.map(({ term, definition }) => ({
      '@type': 'DefinedTerm',
      name: term,
      description: plainText(definition),
      url: `${url}#${slugify(term)}`,
      inDefinedTermSet: `${url}#terms`,
    })),
  };
}

/** One `@graph` document: the nodes reference each other by `@id`. */
export function graph(...nodes: Thing[]): Thing {
  return { '@context': 'https://schema.org', '@graph': nodes };
}

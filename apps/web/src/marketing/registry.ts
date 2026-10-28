import { alternativesPage } from './content/alternatives';
import { BLOG_POSTS } from './content/blog';
import { faqPage } from './content/faq';
import { FEATURE_PAGES } from './content/features';
import { glossaryPage } from './content/glossary';
import type { MarketingPage } from './content/types';

/**
 * Every public page, in one list: the sitemap, /llms.txt, the `.md` twins and
 * the related links all read it, so a page added here is indexed, linked and
 * readable by agents at once. Its route must be under a prefix listed in
 * `paths.ts`.
 */
const UPDATED = '2026-10-28';

export const homePage: MarketingPage = {
  path: '/',
  section: 'home',
  label: 'Home',
  title: 'DukaanAI: GST Billing, Udhar and Inventory App for Kirana Stores',
  description:
    'Billing software for Indian kirana and retail shops: GST bills with CGST and SGST, udhar with credit limits, stock and expiry alerts, cash-drawer shifts and an AI bill scanner.',
  eyebrow: 'For kirana and retail shops in India',
  h1: 'GST billing, udhar and stock for your kirana store',
  lede:
    'DukaanAI is billing and shop-management software for Indian kirana and retail stores. One bill charges GST, moves your stock and records udhar, while shifts keep each cashier’s cash in check and the dashboard tells you what to restock.',
  body: `
## What DukaanAI does

${FEATURE_PAGES.map((page) => `- **[${page.label}](${page.path})**: ${page.description}`).join('\n')}

## Who it is for

Owners of kirana, grocery and general stores in India that sell over the counter, alone or with cashiers. Each person signs in with their own account and role; cashiers never see cost prices, profit or supplier dues.

## How it runs

DukaanAI runs in the web browser on a laptop, tablet or phone. A USB barcode scanner works on the billing screen, and receipts print on 80 mm thermal printers or A4.

## Honest limits

No offline mode, English screens only, built for counter sales to consumers (no buyer GSTIN or HSN on invoices yet, no composition bill of supply, no e-invoicing).
`,
  related: ['/features', '/alternatives', '/faq', '/blog'],
  updated: UPDATED,
};

export const featuresHub: MarketingPage = {
  path: '/features',
  section: 'features',
  label: 'Features',
  title: 'Features: GST Billing, Udhar, Inventory and Cash Control | DukaanAI',
  description:
    'Everything DukaanAI does for a kirana store: GST billing at the counter, udhar with limits, inventory with low-stock and expiry alerts, cash-drawer shifts and an AI bill scanner.',
  eyebrow: 'Features',
  h1: 'Everything a kirana counter needs, in one place',
  lede:
    'Billing, udhar, stock and cash are one system in DukaanAI: a single bill updates all of them, so they agree at the end of the day.',
  body: FEATURE_PAGES.map((page) => `## [${page.label}](${page.path})\n\n${page.description}`).join('\n\n'),
  related: ['/alternatives', '/faq', '/blog'],
  updated: UPDATED,
};

export const blogHub: MarketingPage = {
  path: '/blog',
  section: 'blog',
  label: 'Guides',
  title: 'Kirana Store Guides: GST, Udhar and Inventory | DukaanAI Blog',
  description:
    'Practical guides for Indian shop owners: GST bill format, returns and credit notes, managing udhar, and reorder points for stock.',
  eyebrow: 'Blog',
  h1: 'Guides for running a kirana store',
  lede: 'Plain-language guides to GST billing, credit and stock for Indian shop owners.',
  body: BLOG_POSTS.map((post) => `## [${post.h1}](${post.path})\n\n${post.description}`).join('\n\n'),
  related: ['/features', '/glossary', '/faq'],
  updated: UPDATED,
};

export const MARKETING_PAGES: MarketingPage[] = [
  homePage,
  featuresHub,
  ...FEATURE_PAGES,
  alternativesPage,
  faqPage,
  glossaryPage,
  blogHub,
  ...BLOG_POSTS,
];

export function pageByPath(path: string): MarketingPage | undefined {
  return MARKETING_PAGES.find((page) => page.path === path);
}

export function requirePage(path: string): MarketingPage {
  const page = pageByPath(path);
  if (!page) throw new Error(`No marketing page at ${path}`);
  return page;
}

/** The URL of a page's Markdown twin (`/index.md` for the home page). */
export function markdownPath(path: string): string {
  return path === '/' ? '/index.md' : `${path}.md`;
}

/** The URL of a page's social card (`app/og/[[...slug]]/route.tsx`). */
export function ogImagePath(path: string): string {
  return path === '/' ? '/og' : `/og${path}`;
}

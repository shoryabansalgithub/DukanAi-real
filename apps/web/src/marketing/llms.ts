import { absoluteUrl } from '@/config/site';
import type { MarketingPage } from './content/types';
import { pageMarkdown } from './export';
import { MARKETING_PAGES, markdownPath } from './registry';

const SECTIONS: { title: string; match: (page: MarketingPage) => boolean }[] = [
  { title: 'Product', match: (page) => page.section === 'home' || page.section === 'features' },
  { title: 'Guides', match: (page) => page.section === 'blog' },
  {
    title: 'Reference',
    match: (page) => ['faq', 'glossary', 'alternatives'].includes(page.section),
  },
];

/**
 * /llms.txt in the llmstxt.org format: a title, a one-paragraph summary, the
 * facts an assistant most often gets wrong, then every page as a link to its
 * Markdown twin with a one-line description.
 */
export function llmsTxt(): string {
  const lines = [
    '# DukaanAI',
    '',
    '> DukaanAI is web-based billing and shop-management software for Indian kirana and retail stores: GST billing at the counter (CGST + SGST per line, a serial number series per financial year, 80 mm thermal receipts), udhar (customer credit) with credit limits and ledgers, inventory with reorder-point and expiry alerts, cash-drawer shifts per cashier, staff roles, an AI bill scanner for supplier bills and a dashboard with AI sales forecasts.',
    '',
    'Key facts:',
    '',
    '- Runs in the web browser on laptop, desktop, tablet or phone. Needs an internet connection: there is no offline mode.',
    '- Built for counter sales to consumers (B2C) in India. Not yet supported: buyer GSTIN and HSN codes on invoices, bills of supply for composition dealers, e-invoicing, e-way bills, SMS or WhatsApp reminders, non-English screens.',
    '- Roles: Owner, Admin, Manager, Cashier, Stock Clerk. Cashiers never see cost prices, profit, stock value or supplier dues.',
    '- Every record can be exported on request.',
    `- Sign-up page: ${absoluteUrl('/register')}`,
    '',
  ];
  for (const section of SECTIONS) {
    lines.push(`## ${section.title}`, '');
    for (const page of MARKETING_PAGES.filter(section.match)) {
      lines.push(`- [${page.label}](${absoluteUrl(markdownPath(page.path))}): ${page.description}`);
    }
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    `- [Everything in one file](${absoluteUrl('/llms-full.txt')}): every page above as Markdown.`,
    ''
  );
  return lines.join('\n');
}

/** /llms-full.txt: every page's Markdown, in registry order. */
export function llmsFullTxt(): string {
  return MARKETING_PAGES.map(pageMarkdown).join('\n\n');
}

export const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=3600',
  'X-Robots-Tag': 'noindex',
};

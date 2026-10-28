import { absoluteUrl, siteUrl } from '@/config/site';
import { absolutiseLinks } from './markdown';
import type { MarketingPage } from './content/types';
import { pageByPath } from './registry';

/** A page as plain Markdown for AI agents: the same source as the HTML page, links made absolute. */
export function pageMarkdown(page: MarketingPage): string {
  const origin = siteUrl();
  const parts = [`# ${page.h1}`, page.lede];
  if (page.body.trim()) parts.push(page.body.trim());
  if (page.faqs?.length) {
    parts.push('## Frequently asked questions');
    for (const faq of page.faqs) parts.push(`### ${faq.q}`, faq.a);
  }
  const related = page.related.map(pageByPath).filter((p): p is MarketingPage => Boolean(p));
  if (related.length) {
    parts.push('## Related', related.map((p) => `- [${p.label}](${p.path}): ${p.description}`).join('\n'));
  }
  const dates = page.published ? `Published ${page.published}, updated ${page.updated}` : `Updated ${page.updated}`;
  parts.push(`---\nSource: ${absoluteUrl(page.path)} (${dates})`);
  return `${absolutiseLinks(parts.join('\n\n'), origin)}\n`;
}

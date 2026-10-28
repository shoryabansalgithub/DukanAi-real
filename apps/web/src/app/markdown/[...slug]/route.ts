import { absoluteUrl, siteIndexable } from '@/config/site';
import { pageMarkdown } from '@/marketing/export';
import { MARKDOWN_HEADERS } from '@/marketing/llms';
import { pageByPath } from '@/marketing/registry';

/**
 * The Markdown twin of a public page. Reached as `/<page>.md` (`/index.md`
 * for the home page) through the rewrite in next.config.js; the proxy never
 * sees those paths because they carry an extension.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  if (!siteIndexable()) return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
  const { slug } = await params;
  const path = slug.length === 1 && slug[0] === 'index' ? '/' : `/${slug.join('/')}`;
  const page = pageByPath(path);
  if (!page) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(pageMarkdown(page), { headers: { ...MARKDOWN_HEADERS, Link: `<${absoluteUrl(path)}>; rel="canonical"` } });
}

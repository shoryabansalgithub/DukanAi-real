import { llmsTxt } from '@/marketing/llms';
import { siteIndexable } from '@/config/site';

export const dynamic = 'force-dynamic';

export function GET() {
  if (!siteIndexable())
    return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
  return new Response(llmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

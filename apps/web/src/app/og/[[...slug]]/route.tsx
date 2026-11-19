import { ogCard } from '@/marketing/og-card';
import { pageByPath } from '@/marketing/registry';

/**
 * The 1200×630 social card of a public page, at `/og` (home) or
 * `/og/<page path>`. A route handler rather than `opengraph-image.tsx`, whose
 * file-based card reaches only its own segment and is served under a hashed
 * name: every page gets its own card at a URL `pageMetadata` can name.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const path = slug.length ? `/${slug.join('/')}` : '/';
  const page = pageByPath(path);
  if (!page) return new Response('Not found\n', { status: 404 });
  const response = ogCard({ title: page.h1, kicker: page.eyebrow ?? page.label });
  // The URL carries no version, so a renamed page must reach the card within the hour.
  response.headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  return response;
}

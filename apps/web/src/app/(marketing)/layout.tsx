import type { Viewport } from 'next';

/**
 * The public, indexable pages. Server components only: no session provider,
 * no app shell, so a visitor downloads the Next.js runtime and little else.
 * Paths here must be listed in `src/marketing/paths.ts` (the proxy) and
 * `src/marketing/registry.ts` (sitemap, llms.txt, Markdown twins).
 */
export const viewport: Viewport = { themeColor: '#ffffff' };

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className="marketing-root flex min-h-screen flex-col bg-white font-sans text-slate-900 antialiased [&>main]:flex-1">{children}</div>;
}

import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type { Faq, MarketingPage } from '@/marketing/content/types';
import { pageByPath } from '@/marketing/registry';
import { InlineMarkdown } from './Markdown';

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
}

export function readingMinutes(page: MarketingPage): number {
  const words =
    `${page.lede} ${page.body} ${(page.faqs ?? []).map((f) => `${f.q} ${f.a}`).join(' ')}`.split(
      /\s+/
    ).length;
  return Math.max(1, Math.round(words / 200));
}

/** Home › Section › Page, visible and matching the BreadcrumbList JSON-LD. */
export function Breadcrumbs({ page }: { page: MarketingPage }) {
  const segments = page.path.split('/').filter(Boolean);
  const trail = segments
    .map((_, i) => pageByPath(`/${segments.slice(0, i + 1).join('/')}`))
    .filter((p): p is MarketingPage => Boolean(p));
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link href="/" className="hover:text-slate-800">
            Home
          </Link>
        </li>
        {trail.map((crumb) => (
          <li key={crumb.path} className="flex items-center gap-1">
            <ChevronRight size={14} aria-hidden="true" className="text-slate-400" />
            {crumb.path === page.path ? (
              <span aria-current="page" className="text-slate-700">
                {crumb.label}
              </span>
            ) : (
              <Link href={crumb.path} className="hover:text-slate-800">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Questions as native disclosure widgets: readable without JavaScript, and the answers stay in the HTML for crawlers. */
export function FaqList({
  faqs,
  headingLevel = 'h2',
  title = 'Frequently asked questions',
}: {
  faqs: Faq[];
  headingLevel?: 'h2' | 'none';
  title?: string;
}) {
  return (
    <section aria-labelledby={headingLevel === 'h2' ? 'faq' : undefined}>
      {headingLevel === 'h2' && (
        <h2 id="faq" className="scroll-mt-24 text-2xl font-bold tracking-tight text-slate-900">
          {title}
        </h2>
      )}
      <div
        className={`${headingLevel === 'h2' ? 'mt-5' : ''} divide-y divide-slate-200 border-y border-slate-200`}
      >
        {faqs.map((faq) => (
          <details key={faq.q} className="group py-1">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-4 text-left text-[17px] font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
              <h3 className="font-semibold">{faq.q}</h3>
              <ChevronRight
                size={20}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
              />
            </summary>
            <p className="pb-5 pr-8 text-base leading-relaxed text-slate-600">
              <InlineMarkdown source={faq.a} />
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Cards for related pages: the internal links every page ends with. */
export function RelatedPages({ paths, title = 'Related' }: { paths: string[]; title?: string }) {
  const pages = paths.map(pageByPath).filter((p): p is MarketingPage => Boolean(p));
  if (!pages.length) return null;
  return (
    <section aria-labelledby="related" className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 id="related" className="text-xl font-bold tracking-tight text-slate-900">
          {title}
        </h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {pages.map((page) => (
            <li key={page.path}>
              <Link
                href={page.path}
                className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 transition-shadow hover:border-indigo-200 hover:shadow-md"
              >
                <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                  {page.eyebrow ?? page.label}
                </span>
                <span className="mt-2 font-semibold leading-snug text-slate-900">{page.h1}</span>
                <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-indigo-700">
                  Read{' '}
                  <ArrowRight
                    size={15}
                    aria-hidden="true"
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function CtaBand() {
  return (
    <section className="bg-slate-900">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Bring your counter, khata and stock into one place
          </h2>
          <p className="mt-2 text-base text-slate-300">
            Create your shop account, add your GSTIN and products, and make your first bill.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <Link
            href="/register"
            className="rounded-xl bg-white px-5 py-3 text-[15px] font-semibold text-slate-900 transition-colors hover:bg-indigo-50"
          >
            Create shop account
          </Link>
          <Link
            href="/features"
            className="rounded-xl border border-slate-600 px-5 py-3 text-[15px] font-semibold text-white transition-colors hover:border-slate-400"
          >
            See all features
          </Link>
        </div>
      </div>
    </section>
  );
}

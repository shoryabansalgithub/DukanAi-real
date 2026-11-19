import type { MarketingPage } from '@/marketing/content/types';
import { Markdown, InlineMarkdown } from './Markdown';
import {
  Breadcrumbs,
  CtaBand,
  FaqList,
  formatDate,
  readingMinutes,
  RelatedPages,
} from './PageParts';
import { JsonLd } from './JsonLd';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/** A long-form public page: feature pages, guides, FAQ, glossary, comparisons. */
export function ArticlePage({
  page,
  schema,
}: {
  page: MarketingPage;
  schema: Record<string, unknown>;
}) {
  return (
    <>
      <JsonLd data={schema} />
      <SiteHeader current={page.section} />
      <main>
        <article className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
          <Breadcrumbs page={page} />
          <header className="mt-6 border-b border-slate-200 pb-8">
            {page.eyebrow && (
              <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">
                {page.eyebrow}
              </p>
            )}
            <h1 className="mt-3 text-balance text-[2rem] font-extrabold leading-[1.15] tracking-tight text-slate-900 sm:text-[2.6rem]">
              {page.h1}
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-700 sm:text-xl">
              <InlineMarkdown source={page.lede} />
            </p>
            <p className="mt-5 text-sm text-slate-500">
              {page.published ? (
                <>
                  <time dateTime={page.published}>{formatDate(page.published)}</time> ·{' '}
                  {readingMinutes(page)} min read
                </>
              ) : (
                <>
                  Updated <time dateTime={page.updated}>{formatDate(page.updated)}</time>
                </>
              )}
            </p>
          </header>
          {page.body.trim() && (
            <div className="mt-4">
              <Markdown source={page.body} />
            </div>
          )}
          {page.faqs?.length ? (
            <div className={page.body.trim() ? 'mt-14' : 'mt-8'}>
              <FaqList faqs={page.faqs} headingLevel={page.body.trim() ? 'h2' : 'none'} />
            </div>
          ) : null}
        </article>
        <RelatedPages paths={page.related} />
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}

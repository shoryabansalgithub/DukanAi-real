import { Markdown } from './Markdown';
import { formatDate } from './PageParts';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/** The privacy notice and the terms: a plain document, no call to action. */
export function LegalDocument({
  title,
  lede,
  updated,
  body,
}: {
  title: string;
  lede: string;
  updated: string;
  body: string;
}) {
  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
          <header className="border-b border-slate-200 pb-8">
            <h1 className="text-balance text-[2rem] font-extrabold leading-[1.15] tracking-tight text-slate-900 sm:text-[2.6rem]">
              {title}
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-700">{lede}</p>
            <p className="mt-5 text-sm text-slate-500">
              Last updated <time dateTime={updated}>{formatDate(updated)}</time>
            </p>
          </header>
          <div className="mt-4">
            <Markdown source={body} />
          </div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

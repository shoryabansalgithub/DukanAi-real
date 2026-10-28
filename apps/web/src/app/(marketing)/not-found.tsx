import Link from 'next/link';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SiteHeader } from '@/components/marketing/SiteHeader';

/**
 * The 404 of the public surface: an unknown address under a marketing
 * section, for a visitor and a crawler alike. Next.js answers it with status
 * 404 and a noindex robots tag; it never mounts the app shell.
 */
export default function MarketingNotFound() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28" data-testid="marketing-not-found">
          <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">404</p>
          <h1 className="mt-3 text-balance text-[2rem] font-extrabold leading-[1.15] tracking-tight text-slate-900 sm:text-[2.6rem]">This page could not be found</h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-700">The address may be mistyped, or the page has moved.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/" className="rounded-xl bg-indigo-600 px-5 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-indigo-700">
              Go to the home page
            </Link>
            <Link href="/features" className="rounded-xl border border-slate-300 px-5 py-3 text-[15px] font-semibold text-slate-900 transition-colors hover:border-slate-500">
              See the features
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

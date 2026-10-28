import Link from 'next/link';
import { ArrowRight, Check, Minus } from 'lucide-react';
import { FEATURE_ICONS } from '@/components/marketing/feature-icons';
import { JsonLd } from '@/components/marketing/JsonLd';
import { InlineMarkdown } from '@/components/marketing/Markdown';
import { CtaBand, FaqList } from '@/components/marketing/PageParts';
import { SampleBill } from '@/components/marketing/SampleBill';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { BLOG_POSTS } from '@/marketing/content/blog';
import { GENERAL_FAQS } from '@/marketing/content/faq';
import { FEATURE_PAGES } from '@/marketing/content/features';
import { pageMetadata } from '@/marketing/metadata';
import { homePage } from '@/marketing/registry';
import { faqPage, graph, organization, softwareApplication, webPage, website } from '@/marketing/structured-data';

/**
 * The landing page for a visitor without a session. A signed-in visitor (or
 * any request under the auth bypass) never reaches it: the proxy sends `/`
 * to /dashboard.
 */
export function generateMetadata() {
  return pageMetadata(homePage);
}

const HOME_FAQS = GENERAL_FAQS.filter((faq) =>
  ['What is DukaanAI?', 'Who is DukaanAI for?', 'What devices does it run on?', 'Does DukaanAI work offline?', 'Are DukaanAI bills GST compliant?', 'Can my staff use it with their own logins?'].includes(faq.q),
);

const ONE_BILL = [
  { title: 'Tax', text: 'CGST and SGST worked out per line and summed by rate, in a numbered series for the financial year.' },
  { title: 'Stock', text: 'Every item leaves stock as it is billed, and low stock is flagged at its reorder point.' },
  { title: 'Udhar', text: 'Any part of the bill goes on the customer’s account, checked against their credit limit.' },
  { title: 'Cash', text: 'Cash taken is added to the cashier’s open shift, so the drawer count at closing adds up.' },
];

const ROLES = [
  { role: 'Cashier', can: ['Bill, take payments and give change', 'Make returns', 'Open and close their shift'], cannot: ['See cost prices, profit or supplier dues'] },
  { role: 'Manager', can: ['Everything a cashier does', 'Products, stock and credit limits', 'Bigger discounts and cancellations'], cannot: ['Remove staff or delete products'] },
  { role: 'Owner', can: ['Everything', 'Reports, GST summary export', 'Invite and remove staff'], cannot: [] },
];

const NOT_YET = [
  'Billing without an internet connection',
  'Buyer GSTIN and HSN codes on invoices (B2B billing)',
  'Bills of supply for composition dealers, e-invoicing and e-way bills',
  'Automatic SMS or WhatsApp payment reminders',
  'Screens in languages other than English',
];

export default function HomePage() {
  return (
    <>
      <JsonLd data={graph(website(), organization(), softwareApplication(), webPage(homePage), faqPage(HOME_FAQS, '/'))} />
      <SiteHeader />
      <main>
        <section className="relative isolate overflow-hidden">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 -z-10 h-[520px] bg-gradient-to-b from-indigo-50/70 to-white" />
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-20 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pb-24">
            <div>
              <p className="inline-flex items-center rounded-full border border-indigo-200 bg-white px-3 py-1 text-sm font-medium text-indigo-700">
                {homePage.eyebrow}
              </p>
              <h1 className="mt-5 text-balance text-[2.35rem] font-extrabold leading-[1.08] tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem]">
                {homePage.h1}
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600 sm:text-xl">{homePage.lede}</p>
              <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap [&>a]:sm:w-auto">
                <Link href="/register" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm shadow-indigo-600/30 transition-colors hover:bg-indigo-700">
                  Create shop account <ArrowRight size={18} aria-hidden="true" />
                </Link>
                <Link href="/features" className="inline-flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-slate-800 transition-colors hover:border-slate-400">
                  See how it works
                </Link>
              </div>
              <ul className="mt-8 grid max-w-xl gap-x-6 gap-y-2.5 text-[15px] text-slate-700 sm:grid-cols-2">
                {['CGST + SGST on every bill', 'Udhar with credit limits', 'Low-stock and expiry alerts', 'Runs in any web browser'].map((point) => (
                  <li key={point} className="flex items-center gap-2">
                    <Check size={18} aria-hidden="true" className="shrink-0 text-emerald-600" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
            <SampleBill />
          </div>
        </section>

        <section aria-labelledby="features-heading" className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <h2 id="features-heading" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
                What DukaanAI does for your shop
              </h2>
              <p className="mt-3 text-lg text-slate-600">Five parts of running a counter, built as one system.</p>
            </div>
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURE_PAGES.map((feature) => {
                const Icon = FEATURE_ICONS[feature.path];
                return (
                  <li key={feature.path}>
                    <Link href={feature.path} className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:border-indigo-200 hover:shadow-md">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                        <Icon size={22} aria-hidden="true" />
                      </span>
                      <h3 className="mt-4 text-lg font-bold text-slate-900">{feature.label}</h3>
                      <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{feature.description}</p>
                      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-[15px] font-semibold text-indigo-700">
                        Learn more <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </li>
                );
              })}
              <li className="flex flex-col justify-center rounded-2xl border border-dashed border-slate-300 p-6">
                <h3 className="text-lg font-bold text-slate-900">Comparing apps?</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-600">How DukaanAI differs from Vyapar, myBillBook, OkCredit and Khatabook, from their own websites.</p>
                <Link href="/alternatives" className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-indigo-700">
                  Read the comparison <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="one-bill-heading">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <h2 id="one-bill-heading" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
                One bill, four records, no double entry
              </h2>
              <p className="mt-3 text-lg text-slate-600">
                When you confirm a sale, DukaanAI updates everything it touches in the same step. Nothing is copied from one book to another later.
              </p>
            </div>
            <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {ONE_BILL.map((item, index) => (
                <li key={item.title} className="rounded-2xl border border-slate-200 p-6">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">{index + 1}</span>
                  <h3 className="mt-4 text-lg font-bold text-slate-900">{item.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{item.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="roles-heading" className="border-y border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <h2 id="roles-heading" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
                Your staff, your rules
              </h2>
              <p className="mt-3 text-lg text-slate-600">
                Everyone signs in with their own account. A cashier can sell and take payments without ever seeing what you paid for stock.
              </p>
            </div>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {ROLES.map((role) => (
                <div key={role.role} className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h3 className="text-lg font-bold text-slate-900">{role.role}</h3>
                  <ul className="mt-4 space-y-2.5 text-[15px] text-slate-700">
                    {role.can.map((item) => (
                      <li key={item} className="flex gap-2.5">
                        <Check size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-600" />
                        {item}
                      </li>
                    ))}
                    {role.cannot.map((item) => (
                      <li key={item} className="flex gap-2.5 text-slate-500">
                        <Minus size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-400" />
                        <span>
                          <span className="sr-only">Cannot: </span>
                          {item}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="limits-heading">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-20">
            <div>
              <h2 id="limits-heading" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
                What DukaanAI does not do yet
              </h2>
              <p className="mt-3 text-lg text-slate-600">
                Better you hear it now than after setting up your shop. If one of these matters most to you, our{' '}
                <Link href="/alternatives" className="font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-700">
                  comparison
                </Link>{' '}
                shows which apps cover it.
              </p>
            </div>
            <ul className="space-y-3 self-center">
              {NOT_YET.map((item) => (
                <li key={item} className="flex gap-3 rounded-xl border border-slate-200 px-4 py-3 text-[15px] text-slate-700">
                  <Minus size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-400" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="guides-heading" className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 id="guides-heading" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
                Guides for shop owners
              </h2>
              <Link href="/blog" className="inline-flex items-center gap-1 text-[15px] font-semibold text-indigo-700">
                All guides <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2">
              {BLOG_POSTS.map((post) => (
                <li key={post.path}>
                  <Link href={post.path} className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:border-indigo-200 hover:shadow-md">
                    <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">{post.eyebrow}</span>
                    <h3 className="mt-2 text-lg font-bold leading-snug text-slate-900 group-hover:text-indigo-700">{post.h1}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
                      <InlineMarkdown source={post.description} />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="home-faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-20">
          <h2 id="home-faq" className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
            Questions shop owners ask
          </h2>
          <div className="mt-6">
            <FaqList faqs={HOME_FAQS} headingLevel="none" />
          </div>
          <p className="mt-6 text-[15px] text-slate-600">
            More in the{' '}
            <Link href="/faq" className="font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2">
              full FAQ
            </Link>{' '}
            and the{' '}
            <Link href="/glossary" className="font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2">
              kirana and GST glossary
            </Link>
            .
          </p>
        </section>

        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}

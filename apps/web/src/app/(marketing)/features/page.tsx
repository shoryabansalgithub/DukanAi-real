import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { FEATURE_ICONS } from '@/components/marketing/feature-icons';
import { JsonLd } from '@/components/marketing/JsonLd';
import { Breadcrumbs, CtaBand, RelatedPages } from '@/components/marketing/PageParts';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { absoluteUrl } from '@/config/site';
import { FEATURE_PAGES } from '@/marketing/content/features';
import { pageMetadata } from '@/marketing/metadata';
import { featuresHub } from '@/marketing/registry';
import { breadcrumbs, graph, organization, softwareApplication, webPage } from '@/marketing/structured-data';

export function generateMetadata() {
  return pageMetadata(featuresHub);
}

export default function FeaturesPage() {
  const page = featuresHub;
  const list = {
    '@type': 'ItemList',
    itemListElement: FEATURE_PAGES.map((feature, index) => ({ '@type': 'ListItem', position: index + 1, url: absoluteUrl(feature.path), name: feature.label })),
  };
  return (
    <>
      <JsonLd data={graph(webPage(page), breadcrumbs(page), list, softwareApplication(), organization())} />
      <SiteHeader current="features" />
      <main>
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
          <Breadcrumbs page={page} />
          <header className="mt-6 max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">{page.eyebrow}</p>
            <h1 className="mt-3 text-balance text-[2rem] font-extrabold leading-[1.15] tracking-tight text-slate-900 sm:text-[2.6rem]">{page.h1}</h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-700 sm:text-xl">{page.lede}</p>
          </header>
          <ul className="mt-12 grid gap-5 md:grid-cols-2">
            {FEATURE_PAGES.map((feature) => {
              const Icon = FEATURE_ICONS[feature.path];
              return (
                <li key={feature.path}>
                  <Link
                    href={feature.path}
                    className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:border-indigo-200 hover:shadow-md"
                  >
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      <Icon size={22} aria-hidden="true" />
                    </span>
                    <h2 className="mt-4 text-xl font-bold tracking-tight text-slate-900">{feature.h1}</h2>
                    <p className="mt-2 leading-relaxed text-slate-600">{feature.description}</p>
                    <span className="mt-auto inline-flex items-center gap-1 pt-5 text-[15px] font-semibold text-indigo-700">
                      {feature.label} in detail <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        <RelatedPages paths={page.related} title="Before you choose" />
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}

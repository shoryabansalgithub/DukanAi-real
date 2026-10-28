import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { JsonLd } from '@/components/marketing/JsonLd';
import { Breadcrumbs, CtaBand, formatDate, readingMinutes } from '@/components/marketing/PageParts';
import { SiteFooter } from '@/components/marketing/SiteFooter';
import { SiteHeader } from '@/components/marketing/SiteHeader';
import { absoluteUrl } from '@/config/site';
import { BLOG_POSTS } from '@/marketing/content/blog';
import { pageMetadata } from '@/marketing/metadata';
import { blogHub } from '@/marketing/registry';
import { breadcrumbs, graph, organization, webPage } from '@/marketing/structured-data';

export const metadata = pageMetadata(blogHub);

export default function BlogIndexPage() {
  const page = blogHub;
  const blog = {
    '@type': 'Blog',
    '@id': `${absoluteUrl(page.path)}#blog`,
    name: 'DukaanAI guides',
    url: absoluteUrl(page.path),
    inLanguage: 'en-IN',
    blogPost: BLOG_POSTS.map((post) => ({ '@type': 'BlogPosting', headline: post.h1, url: absoluteUrl(post.path), datePublished: post.published })),
  };
  return (
    <>
      <JsonLd data={graph(webPage(page), breadcrumbs(page), blog, organization())} />
      <SiteHeader current="blog" />
      <main>
        <div className="mx-auto max-w-4xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
          <Breadcrumbs page={page} />
          <header className="mt-6">
            <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">{page.eyebrow}</p>
            <h1 className="mt-3 text-balance text-[2rem] font-extrabold leading-[1.15] tracking-tight text-slate-900 sm:text-[2.6rem]">{page.h1}</h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-700 sm:text-xl">{page.lede}</p>
          </header>
          <ul className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
            {BLOG_POSTS.map((post) => (
              <li key={post.path}>
                <Link href={post.path} className="group block py-7">
                  <p className="text-sm text-slate-500">
                    <span className="font-semibold text-indigo-600">{post.eyebrow}</span> · <time dateTime={post.published}>{formatDate(post.published ?? post.updated)}</time> ·{' '}
                    {readingMinutes(post)} min read
                  </p>
                  <h2 className="mt-2 text-xl font-bold tracking-tight text-slate-900 group-hover:text-indigo-700 sm:text-2xl">{post.h1}</h2>
                  <p className="mt-2 leading-relaxed text-slate-600">{post.description}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-[15px] font-semibold text-indigo-700">
                    Read the guide <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}

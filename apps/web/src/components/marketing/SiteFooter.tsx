import Link from 'next/link';
import { siteIndexable } from '@/config/site';
import { BLOG_POSTS } from '@/marketing/content/blog';
import { FEATURE_PAGES } from '@/marketing/content/features';
import { BrandMark } from './BrandMark';

type FooterLink = { href: string; label: string };

/**
 * Every public page is linked from here, including the guides that are not
 * in the header, so each one is reachable in one click from any page.
 */
const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [{ href: '/features', label: 'All features' }, ...FEATURE_PAGES.map((page) => ({ href: page.path, label: page.label }))],
  },
  { title: 'Guides', links: [{ href: '/blog', label: 'All guides' }, ...BLOG_POSTS.map((post) => ({ href: post.path, label: post.label }))] },
  {
    title: 'Resources',
    links: [
      { href: '/alternatives', label: 'Compare billing apps' },
      { href: '/faq', label: 'FAQ' },
      { href: '/glossary', label: 'Kirana and GST glossary' },
      { href: '/llms.txt', label: 'For AI assistants (llms.txt)' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/register', label: 'Create shop account' },
      { href: '/login', label: 'Log in' },
    ],
  },
];

export function SiteFooter() {
  const columns = siteIndexable() ? COLUMNS : COLUMNS.map((column) => ({ ...column, links: column.links.filter((link) => link.href !== '/llms.txt') }));
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[1.3fr_repeat(4,1fr)]">
          <div className="col-span-2 max-w-xs lg:col-span-1">
            <Link href="/" className="inline-flex items-center gap-2.5">
              <BrandMark size={28} />
              <span className="text-base font-extrabold tracking-tight text-slate-900">DukaanAI</span>
            </Link>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              GST billing, udhar, stock and cash control for kirana and retail shops in India.
            </p>
          </div>
          {columns.map((column) => (
            <div key={column.title}>
              <h2 className="text-sm font-semibold text-slate-900">{column.title}</h2>
              <ul className="mt-3 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.includes('.') ? (
                      <a href={link.href} className="text-sm text-slate-600 hover:text-slate-900">
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-sm text-slate-600 hover:text-slate-900">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">© {new Date().getFullYear()} DukaanAI. Made for Indian shops.</p>
      </div>
    </footer>
  );
}

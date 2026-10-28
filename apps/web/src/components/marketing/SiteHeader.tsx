import Link from 'next/link';
import { Menu } from 'lucide-react';
import type { Section } from '@/marketing/content/types';
import { BrandMark } from './BrandMark';

const NAV: { href: string; label: string; section: Section }[] = [
  { href: '/features', label: 'Features', section: 'features' },
  { href: '/alternatives', label: 'Compare', section: 'alternatives' },
  { href: '/blog', label: 'Guides', section: 'blog' },
  { href: '/faq', label: 'FAQ', section: 'faq' },
];

/**
 * The marketing header. Server-rendered with no client state: the phone menu
 * is a native <details>, so it works before (and without) any JavaScript.
 */
export function SiteHeader({ current }: { current?: Section }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600">
          <BrandMark size={30} />
          <span className="text-[17px] font-extrabold tracking-tight text-slate-900">DukaanAI</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current === item.section ? 'page' : undefined}
              className={`rounded-lg px-3 py-2 text-[15px] font-medium transition-colors ${
                current === item.section ? 'text-indigo-700' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden rounded-lg px-3 py-2 text-[15px] font-medium text-slate-700 hover:text-slate-900 sm:inline-flex">
            Log in
          </Link>
          <Link
            href="/register"
            className="hidden rounded-lg bg-indigo-600 px-4 py-2 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 sm:inline-flex"
          >
            Create shop account
          </Link>
          <details className="group relative md:hidden">
            <summary
              aria-label="Menu"
              className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
            >
              <Menu size={22} aria-hidden="true" />
            </summary>
            <div className="absolute right-0 top-12 w-64 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
              <nav aria-label="Main (mobile)" className="flex flex-col">
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href} className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-slate-700 hover:bg-slate-50">
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 p-2 pt-3">
                <Link href="/login" className="rounded-lg border border-slate-200 px-3 py-2.5 text-center text-[15px] font-semibold text-slate-800">
                  Log in
                </Link>
                <Link href="/register" className="rounded-lg bg-indigo-600 px-3 py-2.5 text-center text-[15px] font-semibold text-white">
                  Create shop account
                </Link>
              </div>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

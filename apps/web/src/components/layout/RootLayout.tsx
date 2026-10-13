'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { signOutEverywhere } from '@/lib/sign-out';
import { Sidebar } from '@/components/navigation/Sidebar';
import { Navbar } from '@/components/navigation/Navbar';
import { AUTH_DISABLED } from '@/lib/auth-bypass';

const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

export function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const isAuthPage = AUTH_PATHS.includes(pathname);

  if (isAuthPage) {
    return <>{children}</>;
  }

  // Both banners are derived from real NextAuth session state.
  const showGuestBanner = status === 'unauthenticated' && !AUTH_DISABLED;
  const showExpiredBanner = status === 'authenticated' && session?.error === 'RefreshAccessTokenError';
  const showBanner = showGuestBanner || showExpiredBanner;

  return (
    <div className="min-h-screen bg-background">
      <div className="print-hidden">
        <Sidebar />
        <Navbar />
      </div>
      {showGuestBanner && (
        <div className="print-hidden fixed left-0 right-0 top-[72px] md:left-64 md:top-16 z-20 flex items-center justify-between gap-3 border-b border-violet-200 bg-violet-50 px-4 py-2 text-xs text-violet-900">
          <span>Guest preview: sign in to view shop data or save changes.</span>
          <Link href="/login" className="whitespace-nowrap font-bold text-violet-700 hover:text-violet-900">Sign in</Link>
        </div>
      )}
      {showExpiredBanner && (
        <div className="print-hidden fixed left-0 right-0 top-[72px] md:left-64 md:top-16 z-20 flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span>Your session has expired and could not be renewed. Sign in again to continue.</span>
          <button
            type="button"
            onClick={() => void signOutEverywhere('/login')}
            className="whitespace-nowrap font-bold text-amber-800 hover:text-amber-950"
          >
            Sign in again
          </button>
        </div>
      )}
      <main className={`md:ml-64 min-h-screen print:ml-0 print:min-h-0 print:pt-0 ${showBanner ? 'pt-28 md:pt-24' : 'pt-20 md:pt-16'}`}>
        <div className="p-4 md:p-6 pb-24 md:pb-6 max-w-7xl mx-auto print:p-0 print:max-w-none">
          {children}
        </div>
      </main>
    </div>
  );
}

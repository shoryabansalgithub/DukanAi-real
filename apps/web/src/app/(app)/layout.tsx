import type { Metadata } from 'next';
import { RootLayout } from '@/components/layout/RootLayout';
import { ToastProvider } from '@/components/ui/Toast';
import Providers from '@/components/Providers';

/**
 * The signed-in application and its sign-in pages. Nothing here is for
 * search engines: every page is noindex (robots.txt also keeps crawlers out
 * of the app paths), and only the `(marketing)` pages are in the sitemap.
 */
export const metadata: Metadata = {
  title: 'DukaanAI - AI-Powered Retail OS',
  description: 'AI-powered retail operating system for small businesses',
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <ToastProvider>
        <RootLayout>{children}</RootLayout>
      </ToastProvider>
    </Providers>
  );
}

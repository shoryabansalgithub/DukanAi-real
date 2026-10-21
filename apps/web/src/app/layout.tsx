import type { Metadata, Viewport } from 'next';
import { RootLayout } from '@/components/layout/RootLayout';
import { ToastProvider } from '@/components/ui/Toast';
import Providers from '@/components/Providers';
import { API_URL_META_NAME, GOOGLE_SIGNIN_META_NAME, googleSignInEnabled, publicApiUrl } from '@/config/env';
import './globals.css';

/**
 * Every route renders per request: the middleware issues a fresh CSP script
 * nonce on each response (roadmap 6.4) and a prerendered page would carry
 * inline scripts without it. The app is session-gated, so nothing was
 * cacheable across users anyway.
 */
export const dynamic = 'force-dynamic';

/** Pinch-zoom stays available (roadmap 6.7): a cashier on a small tablet must be able to zoom. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Built per request (the layout is dynamic): `other` renders the
 * `<meta name="dukaanai-api-url">` the browser reads for the API URL, so the
 * same image serves staging and production with `API_PUBLIC_URL` set at
 * runtime (roadmap 9.9), and `<meta name="dukaanai-google-signin">`, whether
 * this server offers Google sign-in (roadmap 9.19).
 */
export function generateMetadata(): Metadata {
  return {
    title: 'DukaanAI - AI-Powered Retail OS',
    description: 'AI-powered retail operating system for small businesses',
    other: { [API_URL_META_NAME]: publicApiUrl(), [GOOGLE_SIGNIN_META_NAME]: googleSignInEnabled() ? 'on' : 'off' },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <ToastProvider>
            <RootLayout>{children}</RootLayout>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}

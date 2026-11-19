import type { Metadata, Viewport } from 'next';
import { API_URL_META_NAME, GOOGLE_SIGNIN_META_NAME, googleSignInEnabled, publicApiUrl } from '@/config/env';
import { siteUrl } from '@/config/site';
import './globals.css';

/**
 * Every route renders per request: the middleware issues a fresh CSP script
 * nonce on each response (roadmap 6.4) and a prerendered page would carry
 * inline scripts without it. The marketing pages fetch nothing, so they still
 * answer in a few milliseconds.
 *
 * This layout is shared by the two surfaces and stays bare: the app shell
 * (session, toasts, sidebar, navbar) lives in `(app)/layout.tsx`, so the
 * public pages in `(marketing)` load none of its JavaScript.
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
 * this server offers Google sign-in (roadmap 9.19). `metadataBase` turns every
 * page's relative canonical and image URLs into absolute ones on SITE_URL.
 */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl()),
    applicationName: 'DukaanAI',
    other: { [API_URL_META_NAME]: publicApiUrl(), [GOOGLE_SIGNIN_META_NAME]: googleSignInEnabled() ? 'on' : 'off' },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

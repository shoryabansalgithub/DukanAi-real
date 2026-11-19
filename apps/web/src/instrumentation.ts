/**
 * Runs once when the server starts (`next dev`, `next start` and the
 * standalone image alike; the standalone server never loads next.config.js).
 * A malformed SITE_URL or SITE_INDEXABLE stops the process here: thrown, Next only logs the
 * error and keeps listening, and every page then fails because the root
 * layout builds `metadataBase` from it. `fs.writeSync` because
 * `process.exit` can truncate a piped `console.error`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertSiteConfig } = await import('./instrumentation-node');
    assertSiteConfig();
  }
}

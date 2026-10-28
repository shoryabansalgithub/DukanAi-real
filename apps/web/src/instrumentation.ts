import { siteIndexable, siteUrl } from './config/site';

/**
 * Runs once when the server starts (`next dev`, `next start` and the
 * standalone image alike; the standalone server never loads next.config.js).
 * A malformed SITE_URL or SITE_INDEXABLE stops the process here: thrown, Next only logs the
 * error and keeps listening, and every page then fails because the root
 * layout builds `metadataBase` from it. `fs.writeSync` because
 * `process.exit` can truncate a piped `console.error`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    siteUrl();
    siteIndexable();
  } catch (err) {
    const { writeSync } = await import('node:fs');
    writeSync(2, `Refusing to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

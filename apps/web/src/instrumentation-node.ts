import { writeSync } from 'node:fs';
import { siteIndexable, siteUrl } from './config/site';

/** Node-only half of `instrumentation.ts`, kept apart so the Edge bundle never sees `node:fs` or `process.exit`. */
export function assertSiteConfig(): void {
  try {
    siteUrl();
    siteIndexable();
  } catch (err) {
    writeSync(2, `Refusing to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

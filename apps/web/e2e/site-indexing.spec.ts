import { expect, test } from '@playwright/test';
import robots from '../src/app/robots';
import sitemap from '../src/app/sitemap';
import { GET as llmsTxt } from '../src/app/llms.txt/route';
import { GET as llmsFullTxt } from '../src/app/llms-full.txt/route';
import { siteIndexable } from '../src/config/site';
import { pageMetadata } from '../src/marketing/metadata';
import { MARKETING_PAGES } from '../src/marketing/registry';

/**
 * Staging runs the production image with its own SITE_URL, so unless it is
 * kept out of the index it competes with production as duplicate content.
 * Indexing is on by default (production ranks without a flag), off with
 * SITE_INDEXABLE=false and on any Vercel preview. Pure logic over the real
 * route modules: the spec runs in the ordinary e2e project.
 */
const KEYS = ['SITE_INDEXABLE', 'VERCEL_ENV'] as const;

function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void | Promise<void>) {
  return async () => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      await fn();
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
}

async function assertIndexable() {
  expect(siteIndexable()).toBe(true);
  const rules = robots();
  expect(rules.sitemap).toBe('https://dukan-ai-chi.vercel.app/sitemap.xml');
  expect(rules.rules).toEqual([expect.objectContaining({ allow: '/' })]);
  expect(sitemap().length).toBe(MARKETING_PAGES.length);
  expect(pageMetadata(MARKETING_PAGES[0]).robots).toMatchObject({ index: true, follow: true });
  expect(llmsTxt().status).toBe(200);
  expect(llmsFullTxt().status).toBe(200);
}

async function assertClosed() {
  expect(siteIndexable()).toBe(false);
  const rules = robots();
  expect(rules.sitemap).toBeUndefined();
  expect(rules.rules).toEqual([{ userAgent: '*', disallow: '/' }]);
  expect(sitemap()).toEqual([]);
  for (const page of MARKETING_PAGES) expect(pageMetadata(page).robots, page.path).toEqual({ index: false, follow: false });
  expect(llmsTxt().status).toBe(404);
  expect(llmsFullTxt().status).toBe(404);
}

test.describe('site indexing switch', () => {
  test('production with nothing set is indexable', withEnv({}, assertIndexable));
  test('SITE_INDEXABLE=true and Vercel production are indexable', withEnv({ SITE_INDEXABLE: 'true', VERCEL_ENV: 'production' }, assertIndexable));
  test('SITE_INDEXABLE=false (staging) closes the site', withEnv({ SITE_INDEXABLE: 'false' }, assertClosed));
  test('a Vercel preview is never indexed', withEnv({ VERCEL_ENV: 'preview' }, assertClosed));
  test('SITE_INDEXABLE=false wins on Vercel production', withEnv({ SITE_INDEXABLE: 'FALSE', VERCEL_ENV: 'production' }, assertClosed));
  test('any other value is refused', withEnv({ SITE_INDEXABLE: 'no' }, () => {
    expect(() => siteIndexable()).toThrow(/SITE_INDEXABLE must be "true" or "false"/);
  }));
});

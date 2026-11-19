import path from 'node:path';
import { expect, test } from '@playwright/test';
import robots from '../src/app/robots';
import sitemap from '../src/app/sitemap';
import { GET as llmsTxt } from '../src/app/llms.txt/route';
import { GET as llmsFullTxt } from '../src/app/llms-full.txt/route';
import { GET as markdownTwin } from '../src/app/markdown/[...slug]/route';
import { absoluteUrl, siteIndexable, siteUrl } from '../src/config/site';
import { parseLegalDetails } from '../src/config/site-rules';
import { privacyMarkdown, termsMarkdown } from '../src/marketing/legal';
import { parseMarkdown } from '../src/marketing/markdown';
import { pageMetadata } from '../src/marketing/metadata';
import { MARKETING_PAGES } from '../src/marketing/registry';

/**
 * Staging runs the production image with its own SITE_URL, so unless it is
 * kept out of the index it competes with production as duplicate content.
 * Indexing is on by default (production ranks without a flag), off with
 * SITE_INDEXABLE=false and on any Vercel preview. Pure logic over the real
 * route modules: the spec runs in the ordinary e2e project.
 */
const KEYS = ['SITE_INDEXABLE', 'VERCEL_ENV', 'SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const;

function withEnv(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  fn: () => void | Promise<void>
) {
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

function twin(slug: string[]) {
  return markdownTwin(new Request('http://localhost/x.md'), { params: Promise.resolve({ slug }) });
}

async function assertIndexable() {
  expect(siteIndexable()).toBe(true);
  const rules = robots();
  expect(rules.sitemap).toBe('https://dukan-ai-chi.vercel.app/sitemap.xml');
  expect(rules.rules).toEqual([expect.objectContaining({ allow: '/' })]);
  expect(sitemap().length).toBe(MARKETING_PAGES.length);
  expect(pageMetadata(MARKETING_PAGES[0]).robots).toMatchObject({ index: true, follow: true });
  expect(pageMetadata(MARKETING_PAGES[0]).alternates?.types).toEqual({
    'text/markdown': '/index.md',
  });
  expect(llmsTxt().status).toBe(200);
  expect(llmsFullTxt().status).toBe(200);
  expect((await twin(['index'])).status).toBe(200);
}

async function assertClosed() {
  expect(siteIndexable()).toBe(false);
  const rules = robots();
  expect(rules.sitemap).toBeUndefined();
  expect(rules.rules).toEqual([{ userAgent: '*', disallow: '/' }]);
  expect(sitemap()).toEqual([]);
  for (const page of MARKETING_PAGES) {
    expect(pageMetadata(page).robots, page.path).toEqual({ index: false, follow: false });
    expect(pageMetadata(page).alternates, page.path).toEqual({ canonical: page.path });
  }
  expect(llmsTxt().status).toBe(404);
  expect(llmsFullTxt().status).toBe(404);
  const closedTwin = await twin(['index']);
  expect(closedTwin.status).toBe(404);
  expect(closedTwin.headers.get('X-Robots-Tag')).toBe('noindex');
}

test.describe('site indexing switch', () => {
  test('production with nothing set is indexable', withEnv({}, assertIndexable));
  test(
    'SITE_INDEXABLE=true and Vercel production are indexable',
    withEnv({ SITE_INDEXABLE: 'true', VERCEL_ENV: 'production' }, assertIndexable)
  );
  test(
    'SITE_INDEXABLE=false (staging) closes the site',
    withEnv({ SITE_INDEXABLE: 'false' }, assertClosed)
  );
  test('a Vercel preview is never indexed', withEnv({ VERCEL_ENV: 'preview' }, assertClosed));
  test(
    'SITE_INDEXABLE=false wins on Vercel production',
    withEnv({ SITE_INDEXABLE: 'FALSE', VERCEL_ENV: 'production' }, assertClosed)
  );
  test(
    'any other value is refused',
    withEnv({ SITE_INDEXABLE: 'no' }, () => {
      expect(() => siteIndexable()).toThrow(/SITE_INDEXABLE must be "true" or "false"/);
    })
  );
});

/**
 * Every page renders per request, so a SITE_URL the server cannot use passed
 * `next build` and then stopped every server start: on Vercel the whole web
 * app, POS included, went down over an SEO setting. A bare host is now read as
 * https, and anything else unusable fails next.config.js, which `next build`
 * loads (Vercel keeps the previous deployment) as do `next start` and
 * `next dev`.
 */
test.describe('SITE_URL', () => {
  test(
    'blank off Vercel is the fallback address',
    withEnv({}, () => expect(siteUrl()).toBe('https://dukan-ai-chi.vercel.app'))
  );
  test(
    "blank on Vercel is the project's production domain, previews included",
    withEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'dukaanai.in', VERCEL_ENV: 'preview' }, () => {
      expect(siteUrl()).toBe('https://dukaanai.in');
      expect(robots().sitemap).toBeUndefined();
    })
  );
  test(
    "SITE_URL wins over Vercel's production domain",
    withEnv(
      {
        SITE_URL: 'https://shop.example.in',
        VERCEL_PROJECT_PRODUCTION_URL: 'dukaan-ai.vercel.app',
      },
      () => expect(absoluteUrl('/faq')).toBe('https://shop.example.in/faq')
    )
  );
  test(
    'a bare host means https, and a trailing slash is dropped',
    withEnv({ SITE_URL: ' dukaanai.in ' }, () => {
      expect(siteUrl()).toBe('https://dukaanai.in');
      expect(absoluteUrl('/features')).toBe('https://dukaanai.in/features');
    })
  );
  test(
    'an origin with a scheme and port is kept',
    withEnv({ SITE_URL: 'http://localhost:3012/' }, () =>
      expect(siteUrl()).toBe('http://localhost:3012')
    )
  );
  for (const [value, reason] of [
    ['https://dukaanai.in/shop', /origin only/],
    ['https://dukaanai.in?ref=x', /origin only/],
    ['https://user:pw@dukaanai.in', /origin only/],
    ['ftp://dukaanai.in', /http\(s\) address/],
    ['https://', /not a web address/],
    ['dukaan ai.in', /not a web address/],
  ] as const) {
    test(
      `${JSON.stringify(value)} is refused`,
      withEnv({ SITE_URL: value }, () => expect(() => siteUrl()).toThrow(reason))
    );
  }

  test('next.config.js refuses a SITE_URL or SITE_INDEXABLE the site cannot use', () => {
    const configPath = path.resolve(__dirname, '../next.config.js');
    const load = () => {
      delete require.cache[require.resolve(configPath)];
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh CommonJS load of next.config.js per value
      return require(configPath) as { poweredByHeader?: boolean };
    };
    const saved = { SITE_URL: process.env.SITE_URL, SITE_INDEXABLE: process.env.SITE_INDEXABLE };
    try {
      process.env.SITE_URL = 'https://dukaanai.in/app';
      expect(load).toThrow(
        /Refusing to build or start the web: SITE_URL must be the site's origin only/
      );
      process.env.SITE_URL = 'dukaanai.in';
      process.env.SITE_INDEXABLE = 'maybe';
      expect(load).toThrow(/SITE_INDEXABLE must be "true" or "false"/);
      process.env.SITE_INDEXABLE = 'false';
      expect(load().poweredByHeader).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[require.resolve(configPath)];
    }
  });
});

/**
 * The privacy notice and terms (/privacy, /terms) are published only when the
 * deployment names who runs the service and how to reach them; the values are
 * written into Markdown, so they are cleaned, and a half-filled pair or a bad
 * email fails next.config.js like a bad SITE_URL.
 */
test.describe('legal pages', () => {
  const full = {
    LEGAL_OPERATOR_NAME: 'Example Retail Tech Pvt Ltd',
    LEGAL_CONTACT_EMAIL: 'privacy@example.com',
    LEGAL_ADDRESS: '12 MG Road, Jaipur',
    LEGAL_GRIEVANCE_OFFICER: 'A. Sharma',
    LEGAL_CONTACT_PHONE: '+91 98765 43210',
    LEGAL_JURISDICTION: 'Jaipur',
    LEGAL_DATA_LOCATION: 'Azure Central India',
  };

  test('nothing set: no pages', () => expect(parseLegalDetails({})).toBeNull());

  test('half a pair or a bad email is refused', () => {
    expect(() => parseLegalDetails({ LEGAL_OPERATOR_NAME: 'X' })).toThrow(/set together/);
    expect(() => parseLegalDetails({ LEGAL_CONTACT_EMAIL: 'a@b.in' })).toThrow(/set together/);
    expect(() =>
      parseLegalDetails({ LEGAL_OPERATOR_NAME: 'X', LEGAL_CONTACT_EMAIL: 'not-an-email' })
    ).toThrow(/not an email address/);
  });

  test('Markdown and HTML characters in a value are dropped', () => {
    const d = parseLegalDetails({
      LEGAL_OPERATOR_NAME: ' **Shop** [x](/y) <b>Co</b> ',
      LEGAL_CONTACT_EMAIL: 'a@b.in',
    });
    expect(d?.operator).toBe('Shop x (/y) b Co /b');
  });

  for (const [name, details] of [
    ['every optional value set', full],
    [
      'only the two required values',
      {
        LEGAL_OPERATOR_NAME: full.LEGAL_OPERATOR_NAME,
        LEGAL_CONTACT_EMAIL: full.LEGAL_CONTACT_EMAIL,
      },
    ],
  ] as const) {
    test(`both documents render in the Markdown subset: ${name}`, () => {
      const d = parseLegalDetails(details)!;
      for (const source of [privacyMarkdown(d), termsMarkdown(d)]) {
        expect(() => parseMarkdown(source)).not.toThrow();
        expect(source).toContain('Example Retail Tech Pvt Ltd');
        expect(source).toContain('[privacy@example.com](mailto:privacy@example.com)');
        // `> ` opens a callout; anywhere else an angle bracket would be a draft placeholder.
        expect(source.replace(/^> /gm, '')).not.toMatch(/[<>]|undefined|null/);
      }
      expect(termsMarkdown(d)).toContain(
        'LEGAL_JURISDICTION' in details ? 'the courts of Jaipur' : 'the courts of India'
      );
    });
  }

  test('next.config.js refuses a half-filled pair', () => {
    const configPath = path.resolve(__dirname, '../next.config.js');
    const saved = process.env.LEGAL_OPERATOR_NAME;
    try {
      process.env.LEGAL_OPERATOR_NAME = 'Example Retail Tech Pvt Ltd';
      delete require.cache[require.resolve(configPath)];
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh CommonJS load of next.config.js
      expect(() => require(configPath)).toThrow(/LEGAL_OPERATOR_NAME and LEGAL_CONTACT_EMAIL/);
    } finally {
      if (saved === undefined) delete process.env.LEGAL_OPERATOR_NAME;
      else process.env.LEGAL_OPERATOR_NAME = saved;
      delete require.cache[require.resolve(configPath)];
    }
  });
});

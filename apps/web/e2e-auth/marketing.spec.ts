import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MARKETING_SECTIONS } from '../src/marketing/paths';

/**
 * The public marketing surface (src/app/(marketing)) as a visitor and a
 * crawler meet it, without the auth bypass: `/` is the landing page for a
 * visitor and the dashboard for a signed-in owner, every page in the sitemap
 * answers 200 as an indexable page with its own canonical, social card,
 * JSON-LD and Markdown twin, and the application stays out of the index.
 */

const PASSWORD = 'Str0ng-Passw0rd!';
/** Canonical URLs are built from SITE_URL, which the test servers leave at its default. */
const SITE_ORIGIN = 'https://dukan-ai-chi.vercel.app';

function stamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

async function sitemapPaths(request: APIRequestContext): Promise<string[]> {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThan(10);
  for (const loc of locs) expect(loc.startsWith(SITE_ORIGIN)).toBe(true);
  return locs.map((loc) => loc.slice(SITE_ORIGIN.length) || '/');
}

function attr(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1];
}

async function registerOwner(page: Page): Promise<void> {
  const id = stamp();
  await page.goto('/register');
  await page.getByPlaceholder('Rajesh Kumar').fill('Marketing Owner');
  await page.getByPlaceholder('Kumar General Store').fill(`Marketing Shop ${id}`);
  await page.getByPlaceholder('rajesh@example.com').fill(`marketing-${id}@example.com`);
  await page.getByPlaceholder('Min. 12 characters').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Store' }).click();
  await page.waitForURL('**/dashboard');
}

test.describe('marketing site', () => {
  test('a visitor gets the landing page without the app shell; a signed-in owner goes to the dashboard', async ({ page }) => {
    const sessionCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/session')) sessionCalls.push(req.url());
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('GST billing, udhar and stock for your kirana store');
    await expect(page.getByRole('link', { name: 'Create shop account' }).first()).toHaveAttribute('href', '/register');
    // No sidebar, no session provider: the public pages load none of the app's client code.
    await expect(page.getByRole('complementary')).toHaveCount(0);
    expect(sessionCalls).toEqual([]);

    await page.getByRole('link', { name: 'Create shop account' }).first().click();
    await page.waitForURL('**/register');
    await registerOwner(page);

    await page.goto('/');
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // A public page stays readable while signed in.
    expect((await page.goto('/features'))?.status()).toBe(200);

    // An unknown address keeps the app shell for a signed-in user.
    const missing = await page.goto('/no-such-app-page');
    expect(missing?.status()).toBe(404);
    await expect(page.getByTestId('app-not-found')).toBeVisible();
    await expect(page.getByRole('complementary')).toBeVisible();

    await page.goto('/dashboard');
    await page.getByTitle('Sign out').click();
    await page.waitForURL('**/login**');
    await expect
      .poll(async () => page.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((s) => Boolean(s && s.user))))
      .toBe(false);
    await page.goto('/');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('an unknown address under a marketing section is the marketing 404 for a visitor, never the app shell', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url());
    });
    for (const section of MARKETING_SECTIONS) {
      for (const missing of [`${section}/no-such-page`, `${section}/no-such-page/deeper`]) {
        const response = await page.goto(missing);
        expect(response?.status(), missing).toBe(404);
        expect(new URL(page.url()).pathname, missing).toBe(missing);
        await expect(page.getByTestId('marketing-not-found'), missing).toBeVisible();
        await expect(page.getByTestId('app-not-found'), missing).toHaveCount(0);
        await expect(page.getByRole('complementary'), missing).toHaveCount(0);
        await expect(page.getByText('Guest preview'), missing).toHaveCount(0);
        await expect(page.locator('meta[name="robots"]').first(), missing).toHaveAttribute('content', /noindex/);
      }
    }
    expect(apiCalls).toEqual([]);

    // Anything else that is not a page sends a visitor to sign in rather than into the shell.
    for (const missing of ['/login/no-such-page', '/apple-icon/no-such-page', '/no-such-app-page']) {
      await page.goto(missing);
      await page.waitForURL('**/login?callbackUrl=**');
      await expect(page.getByRole('complementary'), missing).toHaveCount(0);
    }
  });

  test('every sitemap page is indexable with its own title, canonical, card, JSON-LD and Markdown twin', async ({ request }) => {
    const paths = await sitemapPaths(request);
    const titles = new Set<string>();
    for (const pagePath of paths) {
      const res = await request.get(pagePath, { maxRedirects: 0 });
      expect(res.status(), pagePath).toBe(200);
      const html = await res.text();

      const title = attr(html, /<title>([^<]+)<\/title>/);
      expect(title, pagePath).toBeTruthy();
      expect(titles.has(title!), `duplicate title ${title}`).toBe(false);
      titles.add(title!);
      expect(attr(html, /<meta name="description" content="([^"]+)"/)?.length ?? 0, pagePath).toBeGreaterThan(50);
      expect(attr(html, /<meta name="robots" content="([^"]+)"/), pagePath).toMatch(/^index, follow/);
      expect(attr(html, /<link rel="canonical" href="([^"]+)"/), pagePath).toBe(`${SITE_ORIGIN}${pagePath === '/' ? '' : pagePath}`);
      expect((html.match(/<h1[\s>]/g) ?? []).length, pagePath).toBe(1);

      const card = attr(html, /<meta property="og:image" content="([^"]+)"/);
      expect(card, pagePath).toBeTruthy();
      const image = await request.get(card!.replace(SITE_ORIGIN, ''));
      expect(image.status(), card).toBe(200);
      expect(image.headers()['content-type']).toBe('image/png');

      const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1]));
      expect(blocks, pagePath).toHaveLength(1);
      const graph = blocks[0]['@graph'] as { '@type': string }[];
      expect(blocks[0]['@context']).toBe('https://schema.org');
      const types = graph.map((node) => node['@type']);
      expect(types, pagePath).toContain('WebPage');
      if (pagePath !== '/') expect(types, pagePath).toContain('BreadcrumbList');
      if (pagePath.startsWith('/blog/')) expect(types, pagePath).toContain('BlogPosting');
      if (html.includes('id="faq"') || pagePath === '/faq') expect(types, pagePath).toContain('FAQPage');

      const twin = attr(html, /<link rel="alternate" type="text\/markdown" href="([^"]+)"/);
      expect(twin, pagePath).toBe(`${SITE_ORIGIN}${pagePath === '/' ? '/index.md' : `${pagePath}.md`}`);
      const markdown = await request.get(twin!.replace(SITE_ORIGIN, ''));
      expect(markdown.status(), twin).toBe(200);
      expect(markdown.headers()['content-type']).toContain('text/markdown');
      expect(await markdown.text()).toMatch(/^# \S/);
    }
  });

  test('every public page is linked from the footer and every internal link resolves', async ({ request }) => {
    const paths = await sitemapPaths(request);
    const home = await (await request.get('/')).text();
    const footer = home.slice(home.lastIndexOf('<footer'));
    const footerLinks = new Set([...footer.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]));
    for (const pagePath of paths.filter((p) => p !== '/')) expect(footerLinks.has(pagePath), pagePath).toBe(true);

    const internal = new Set<string>();
    for (const pagePath of paths) {
      const html = await (await request.get(pagePath)).text();
      for (const m of html.matchAll(/<a [^>]*href="(\/[^"#?]*)"/g)) internal.add(m[1]);
    }
    for (const link of internal) {
      const res = await request.get(link, { maxRedirects: 0 });
      expect(res.status(), link).toBe(200);
    }
  });

  test('the application and sign-in pages stay out of the index', async ({ request }) => {
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    // Every app route directory is closed to crawlers (route groups and the `[...missing]` catch-all are not addresses).
    const appDir = path.resolve(__dirname, '../src/app/(app)');
    const routes = fs.readdirSync(appDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[([]/.test(d.name));
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) expect(robots, route.name).toContain(`Disallow: /${route.name}\n`);

    const paths = await sitemapPaths(request);
    for (const route of routes) expect(paths.some((p) => p.startsWith(`/${route.name}`)), route.name).toBe(false);
    for (const authPage of ['/login', '/register', '/forgot-password', '/reset-password']) {
      expect(paths, authPage).not.toContain(authPage);
      const html = await (await request.get(authPage)).text();
      expect(attr(html, /<meta name="robots" content="([^"]+)"/), authPage).toBe('noindex, nofollow');
    }
    const dashboard = await request.get('/dashboard', { maxRedirects: 0 });
    expect(dashboard.status()).toBe(307);
    expect(dashboard.headers().location).toContain('/login?callbackUrl=%2Fdashboard');
  });

  test('llms.txt lists every sitemap page by its Markdown twin, and every link resolves', async ({ request }) => {
    const res = await request.get('/llms.txt');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.startsWith('# DukaanAI\n\n> ')).toBe(true);
    const links = [...text.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
    for (const pagePath of await sitemapPaths(request)) {
      expect(links, pagePath).toContain(`${SITE_ORIGIN}${pagePath === '/' ? '/index.md' : `${pagePath}.md`}`);
    }
    for (const link of links) expect((await request.get(link.replace(SITE_ORIGIN, ''))).status(), link).toBe(200);
    expect((await request.get('/no-such-page.md')).status()).toBe(404);
  });

  test('the landing page fits a 390 px phone and its menu opens without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeHidden();
    await page.getByLabel('Menu').click();
    await expect(page.getByRole('navigation', { name: 'Main (mobile)' }).getByRole('link', { name: 'Compare' })).toBeVisible();
    await context.close();
  });
});

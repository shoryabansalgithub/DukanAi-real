import { expect, test, type Page } from '@playwright/test';

/**
 * Two layout defects found building the profile popup (2026-10-28):
 * - `--font-sans` was never defined, so Tailwind's `var(--font-sans), …`
 *   font stack was void and every page, app and auth alike, rendered in the
 *   browser's serif default (Times).
 * - On a phone the navbar search shared the free width with an empty spacer
 *   and started under the sidebar's menu button: the box showed "Sea".
 */

const SIZES = [
  { width: 1440, height: 900, label: 'desktop 1440x900' },
  { width: 390, height: 844, label: 'phone 390x844' },
];

async function renderedFontFamily(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
}

for (const size of SIZES) {
  test(`app and auth pages render in the sans stack: ${size.label}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    for (const selector of ['h1', 'nav input[type="search"]']) {
      const family = await renderedFontFamily(page, selector);
      expect(family, `${selector} on /dashboard`).toMatch(/sans-serif/);
      expect(family, `${selector} on /dashboard`).not.toMatch(/^"?Times/);
    }

    // `/login` leaves for the dashboard under the bypass; register stays put.
    await page.goto('/register');
    const family = await renderedFontFamily(page, 'h1, h2');
    expect(family, 'heading on /register').toMatch(/sans-serif/);
    expect(family, 'heading on /register').not.toMatch(/^"?Times/);
  });
}

test('navbar search is usable on a 390px phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');

  const search = page.getByRole('searchbox', { name: 'Search products' });
  await expect(search).toBeInViewport({ ratio: 1 });
  const box = await search.boundingBox();
  const menu = await page.getByRole('button', { name: 'Open menu' }).boundingBox();
  expect(box && menu).toBeTruthy();
  // Clear of the fixed menu button, and wide enough to read what is typed.
  expect(box!.x).toBeGreaterThanOrEqual(menu!.x + menu!.width);
  expect(box!.width).toBeGreaterThanOrEqual(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await search.fill('basmati rice');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/products\?q=basmati%20rice$/);
});

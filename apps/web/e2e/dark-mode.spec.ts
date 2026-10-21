import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dark mode (release audit, 2026-10-12): `.dark` inverts `white` and the
 * gray scale through CSS variables (globals.css), so a `dark:` variant on
 * one of those colours flips it back: `dark:bg-gray-900` painted every
 * dialog white while its labels and fields kept the light foreground (white
 * on white, contrast 1.05:1). These tests keep both halves of the fix: no
 * such variant in the source, and every label and field in the forms people
 * use readable in dark mode.
 */

const SRC = path.resolve(__dirname, '../src');
const INVERTED_VARIANT = /dark:(?:[a-z]+:)*(?:bg|text|border|ring|divide|placeholder|from|via|to)-(?:white|gray-\d+)(?:\/\d+)?\b/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

/** WCAG contrast of two opaque rgb() colours. */
function contrast(foreground: number[], background: number[]): number {
  const luminance = ([r, g, b]: number[]) =>
    [r, g, b]
      .map((v) => v / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((sum, s, i) => sum + s * [0.2126, 0.7152, 0.0722][i], 0);
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

type Sample = { kind: string; text: string; color: number[]; background: number[] };

const FORM_TEXT = 'label, h3, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), select, textarea';

/** The matching elements inside `container` with their colour and the composited background behind them. */
async function sample(container: Locator, selector: string): Promise<Sample[]> {
  return container.evaluate((root, fields) => {
    const parse = (value: string): number[] => (value.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number);
    const backgroundOf = (element: Element | null): number[] => {
      const layers: number[][] = [];
      for (let el = element; el; el = el.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor);
        if (a > 0) layers.push([r, g, b, a]);
        if (a >= 1) break;
      }
      // Composite from the bottom layer up; a stack with no opaque layer sits on white.
      return layers.reverse().reduce((under, [r, g, b, a]) => [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)], [255, 255, 255]);
    };
    return Array.from(root.querySelectorAll(fields))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({
        kind: el.tagName.toLowerCase(),
        text: ((el as HTMLInputElement).value || el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 40),
        color: parse(getComputedStyle(el).color).slice(0, 3),
        background: backgroundOf(el),
      }));
  }, selector);
}

async function expectReadable(page: Page, form: string, container: Locator = page.getByRole('dialog'), selector = FORM_TEXT) {
  const samples = await sample(container, selector);
  expect(samples.length, `${form}: nothing sampled`).toBeGreaterThan(3);
  const unreadable = samples
    .map((s) => ({ ...s, ratio: Number(contrast(s.color, s.background).toFixed(2)) }))
    .filter((s) => s.ratio < 4.5)
    .map((s) => `${s.kind} "${s.text}" ${s.ratio}:1`);
  expect(unreadable, `${form}: text below 4.5:1 in dark mode`).toEqual([]);
}

test('no dark: variant re-inverts white or the gray scale', () => {
  const offenders = sourceFiles(SRC).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => (INVERTED_VARIANT.test(line) ? `${path.relative(SRC, file)}:${i + 1} ${line.match(INVERTED_VARIANT)![0]}` : null))
      .filter((hit): hit is string => hit !== null),
  );
  expect(offenders).toEqual([]);
});

test.describe('dark mode forms', () => {
  test.use({ colorScheme: 'dark' });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('theme', 'dark'); } catch { /* storage blocked: the OS preference applies */ }
    });
  });

  test('add product, record expense, add supplier and add customer read in dark mode', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Add Product' }).click();
    await page.getByRole('dialog').locator('input').first().fill('Parle-G 100g');
    await expectReadable(page, 'Add product');
    await page.keyboard.press('Escape');

    await page.goto('/expenses');
    await page.getByRole('button', { name: /Record Expense/ }).first().click();
    await page.getByRole('dialog').locator('input').first().fill('Electricity bill');
    await expectReadable(page, 'Record expense');
    await page.keyboard.press('Escape');

    await page.goto('/suppliers');
    await page.getByRole('button', { name: /Add Supplier/ }).first().click();
    await page.getByRole('dialog').locator('input').first().fill('Sharma Traders');
    await expectReadable(page, 'Add supplier');
    await page.keyboard.press('Escape');

    await page.goto('/customers');
    await page.getByRole('button', { name: 'Add customer' }).click();
    await page.getByRole('dialog').locator('input').first().fill('Asha Verma');
    await expectReadable(page, 'Add customer');
  });

  test('the sidebar keeps its light text on navy in dark mode', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveClass(/dark/);
    // Brand name, menu labels and the Upgrade card title (the inverted palette turned them near black);
    // the purple active link and the coloured badges are the same in both themes.
    await expectReadable(page, 'Sidebar', page.locator('aside').first(), 'a div.font-bold, nav a:not([aria-current]) div span, h4');
  });
});

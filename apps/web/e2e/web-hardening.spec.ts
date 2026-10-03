import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Roadmap 6.4 / 6.5 / 6.6: security headers and a nonce-based CSP on every
 * page, a callbackUrl that can never leave the origin, the production guard
 * on the auth bypass, the anonymous POS cart carried into the shop scope,
 * and the navbar search landing on the products page with `q` applied.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const PRODUCTS_PATH = `${new URL(API_URL).pathname}/products`;

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Console messages the browser prints when the CSP blocks something. */
function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (execute|load|apply|connect)/i.test(text)) violations.push(text);
  });
  return violations;
}

test.describe('security headers (6.4)', () => {
  test('every page answers with the security headers and a nonce-based CSP that the page satisfies', async ({ page }) => {
    const violations = collectCspViolations(page);
    for (const route of ['/dashboard', '/products', '/login']) {
      const response = await page.goto(route);
      expect(response, route).not.toBeNull();
      const headers = response!.headers();
      expect(headers['x-powered-by'], route).toBeUndefined();
      expect(headers['x-content-type-options'], route).toBe('nosniff');
      expect(headers['x-frame-options'], route).toBe('DENY');
      expect(headers['referrer-policy'], route).toBe('strict-origin-when-cross-origin');
      expect(headers['strict-transport-security'], route).toContain('max-age=63072000');
      expect(headers['permissions-policy'], route).toContain('camera=(self)');
      expect(headers['permissions-policy'], route).toContain('microphone=()');

      const csp = headers['content-security-policy'];
      expect(csp, route).toBeDefined();
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp).toContain(`connect-src 'self' ${new URL(API_URL).origin}`);

      // Next.js stamped its inline scripts with the nonce from the request header.
      const nonce = /'nonce-([^']+)'/.exec(csp)![1];
      const stamped = await page.locator(`script[nonce="${nonce}"], script[nonce]`).count();
      expect(stamped, route).toBeGreaterThan(0);
      await expect(page.locator('body')).toBeVisible();
    }
    // Two different pages got two different nonces.
    const a = (await page.goto('/dashboard'))!.headers()['content-security-policy'];
    const b = (await page.goto('/dashboard'))!.headers()['content-security-policy'];
    expect(/'nonce-([^']+)'/.exec(a)![1]).not.toBe(/'nonce-([^']+)'/.exec(b)![1]);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  test('the auth bypass cannot be built or started in production', () => {
    const configPath = path.resolve(__dirname, '../next.config.js');
    const previous = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_AUTH_DISABLED: process.env.NEXT_PUBLIC_AUTH_DISABLED };
    const load = () => {
      delete require.cache[require.resolve(configPath)];
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh CommonJS load of next.config.js under each NODE_ENV
      return require(configPath) as { poweredByHeader?: boolean; headers?: () => Promise<Array<{ headers: Array<{ key: string }> }>> };
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.NEXT_PUBLIC_AUTH_DISABLED = 'true';
      expect(load).toThrow(/NEXT_PUBLIC_AUTH_DISABLED is set while NODE_ENV=production/);

      process.env.NEXT_PUBLIC_AUTH_DISABLED = '';
      const config = load();
      expect(config.poweredByHeader).toBe(false);

      process.env.NODE_ENV = 'development';
      process.env.NEXT_PUBLIC_AUTH_DISABLED = 'true';
      expect(load).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous.NODE_ENV;
      process.env.NEXT_PUBLIC_AUTH_DISABLED = previous.NEXT_PUBLIC_AUTH_DISABLED;
      delete require.cache[require.resolve(configPath)];
    }
  });
});

test.describe('callbackUrl (6.4) and navbar search (6.6)', () => {
  test('a forged callbackUrl never leaves the origin; a same-origin one is honoured', async ({ page }) => {
    // The bypass signs the visitor in, so /login bounces to the callback exactly as after a real sign-in.
    for (const forged of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example/steal', 'javascript:alert(1)', '/login']) {
      await page.goto(`/login?callbackUrl=${encodeURIComponent(forged)}`);
      await page.waitForURL('**/dashboard');
      expect(new URL(page.url()).origin).toBe(new URL(process.env.E2E_WEB_URL ?? 'http://localhost:3010').origin);
    }
    await page.goto(`/login?callbackUrl=${encodeURIComponent('/products?q=chai')}`);
    await page.waitForURL('**/products?q=chai');
    await expect(page.getByPlaceholder('Search by product name or SKU...')).toHaveValue('chai');
  });

  test('the navbar search lands on the products page with q applied, and again while already there', async ({ page }) => {
    await page.goto('/dashboard');
    const first = page.waitForResponse((r) => new URL(r.url()).pathname === PRODUCTS_PATH && new URL(r.url()).searchParams.get('q') === 'biscuit');
    await page.getByLabel('Search products').fill('biscuit');
    await page.getByLabel('Search products').press('Enter');
    await page.waitForURL('**/products?q=biscuit');
    expect((await first).status()).toBe(200);
    await expect(page.getByPlaceholder('Search by product name or SKU...')).toHaveValue('biscuit');

    const second = page.waitForResponse((r) => new URL(r.url()).pathname === PRODUCTS_PATH && new URL(r.url()).searchParams.get('q') === 'tea');
    await page.getByLabel('Search products').fill('tea');
    await page.getByLabel('Search products').press('Enter');
    await page.waitForURL('**/products?q=tea');
    expect((await second).status()).toBe(200);
    await expect(page.getByPlaceholder('Search by product name or SKU...')).toHaveValue('tea');
  });
});

test.describe('POS robustness (6.5)', () => {
  test('a cart built before the shop was known is carried into the shop scope and the anonymous copy is dropped', async ({ page, request }) => {
    const product = await (await request.post(`${API_URL}/products`, {
      data: { name: unique('Anon cart service'), type: 'SERVICE', costPrice: 0, sellingPrice: 25, mrp: 25, wholesalePrice: 25, unit: 'PCS', gstRate: 'ZERO' },
    })).json();
    const shop = (await (await request.get(`${API_URL}/shops/me`)).json()) as { id: string };
    const anonCart = {
      state: {
        lines: [{ lineId: '11111111-2222-4333-8444-555555555555', productId: product.id, isCustom: false, name: product.name, sku: product.sku, unit: 'PCS', unitPrice: 25, mrp: 25, gstRate: 'ZERO', cessRate: 0, stockSnapshot: null, quantity: 2, discountPercent: 0, productType: 'SERVICE' }],
        customer: null,
        discount: { type: 'FIXED_AMOUNT', value: 0, reason: '' },
        notes: 'from the anonymous scope',
        heldCarts: [],
        idempotencyKey: null,
      },
      version: 0,
    };
    await page.addInitScript(
      ({ key, value, shopKey }) => {
        sessionStorage.setItem(key, value);
        sessionStorage.removeItem(shopKey);
      },
      { key: 'dukaanai-pos:anon', value: JSON.stringify(anonCart), shopKey: `dukaanai-pos:${shop.id}` },
    );

    await page.goto('/billing');
    const cart = page.getByTestId('cart-lines');
    await expect(cart.getByTestId('cart-line-name').filter({ hasText: product.name })).toBeVisible();
    await expect(cart.getByTestId('cart-line')).toHaveCount(1);
    await expect.poll(async () => page.evaluate((key) => sessionStorage.getItem(key), 'dukaanai-pos:anon')).toBeNull();
    const scoped = await page.evaluate((key) => sessionStorage.getItem(key), `dukaanai-pos:${shop.id}`);
    expect(scoped).not.toBeNull();
    const persisted = JSON.parse(scoped!) as { state: { lines: Array<{ productId: string; quantity: number }>; notes: string } };
    expect(persisted.state.lines).toEqual([expect.objectContaining({ productId: product.id, quantity: 2 })]);
    expect(persisted.state.notes).toBe('from the anonymous scope');
  });

  test('route error boundaries exist for the app and the root layout', async () => {
    const fs = await import('node:fs');
    expect(fs.existsSync(path.resolve(__dirname, '../src/app/error.tsx'))).toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '../src/app/global-error.tsx'))).toBe(true);
  });
});

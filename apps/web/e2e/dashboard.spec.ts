import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { formatMoney } from '../src/components/customers/format';

/**
 * Browser-level dashboard certification (EXEC-005).
 *
 * Runs against the servers started by playwright.config.ts with the auth
 * bypass on (every request is the provisioned system user's shop). Data is
 * created through the API and the page is compared with what the API returns,
 * so earlier data in the shared test database cannot break an assertion.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const DASHBOARD = /\/api\/dashboard\/(summary|kpis|trends|insights)(\?|$)/;

interface Summary {
  todaySales: number;
  todayOrders: number;
  lowStockCount: number;
  outOfStockCount: number;
  failedSections: string[];
  [key: string]: unknown;
}

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();
}

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = method === 'GET' ? await request.get(`${API_URL}${path}`) : await request.post(`${API_URL}${path}`, { data });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** A stock-tracked product with `stock` units on hand (opening balance through the inventory domain). */
async function stockedProduct(request: APIRequestContext, stock: number): Promise<{ id: string; name: string }> {
  const name = unique('E2E Dash');
  const product = await api<{ id: string }>(request, 'POST', '/products', {
    name,
    sku: `DSH-${randomUUID().slice(0, 8)}`,
    type: 'SIMPLE',
    unit: 'PCS',
    gstRate: 'EIGHTEEN',
    costPrice: 60,
    sellingPrice: 100,
    mrp: 100,
    wholesalePrice: 90,
  });
  const item = await api<{ id: string }>(request, 'POST', '/inventory-domain', { productId: product.id });
  await api(request, 'POST', `/inventory-domain/${item.id}/adjust`, { reason: 'OPENING_BALANCE', quantityChange: stock, notes: 'e2e dashboard' });
  return { id: product.id, name };
}

async function sell(request: APIRequestContext, productId: string, quantity: number): Promise<void> {
  await api(request, 'POST', '/billing/invoice', {
    idempotencyKey: randomUUID(),
    items: [{ productId, quantity }],
    payments: [{ tender: 'CASH', amount: 118 * quantity }],
  });
}

function trackDashboardCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    const match = DASHBOARD.exec(req.url());
    if (match) calls.push(match[1]);
  });
  return calls;
}

const tileValue = (page: Page, label: string) =>
  page.locator('p', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }).locator('xpath=following-sibling::h3[1]');
const kpiValue = (page: Page, label: string) => page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

async function waitLoaded(page: Page) {
  await expect(page.getByText(/^Updated \d/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('dl dt', { hasText: 'Net revenue' })).toBeVisible();
}

test.describe('Dashboard', () => {
  test('shows live data that matches the API, with working low-stock and AI insight cards', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const product = await stockedProduct(request, 12);
    await sell(request, product.id, 3); // 12 -> 9, at/below the default reorder point of 10

    await page.goto('/dashboard');
    await waitLoaded(page);

    const summary = await api<Summary>(request, 'GET', '/dashboard/summary');
    expect(summary.failedSections).toEqual([]);
    await expect(tileValue(page, "Today's sales (net)")).toHaveText(formatMoney(summary.todaySales));
    await expect(tileValue(page, "Today's orders")).toHaveText(summary.todayOrders.toLocaleString('en-IN'));
    // Tiles and KPI strip agree: the sale dropped the KPI cache when it committed.
    await expect(kpiValue(page, 'Net revenue')).toHaveText(formatMoney(summary.todaySales));

    // Low stock card and AI restock suggestion both name the product.
    const lowStockCard = page.locator('div', { has: page.getByRole('heading', { name: 'Low stock', exact: true }) }).last();
    await expect(page.getByRole('heading', { name: 'AI insights' })).toBeVisible();
    await expect(page.getByLabel('Restock suggestions')).toBeVisible();
    await expect(page.getByLabel('Sales forecast')).toBeVisible();
    expect(errors).toEqual([]);

    // The low-stock link opens the inventory Low Stock tab with the product in it.
    await lowStockCard.getByRole('link', { name: /View all/ }).first().click();
    await expect(page).toHaveURL(/\/inventory\?tab=low-stock$/);
    await expect(page.getByRole('cell', { name: product.name })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Module Coming Soon')).toHaveCount(0);
  });

  test('updates on the next 30 s poll after a sale; KPIs and tiles agree', async ({ page, request }) => {
    const product = await stockedProduct(request, 20);
    await page.clock.install();
    await page.goto('/dashboard');
    await waitLoaded(page);
    const before = await api<Summary>(request, 'GET', '/dashboard/summary');
    await expect(tileValue(page, "Today's sales (net)")).toHaveText(formatMoney(before.todaySales));

    await sell(request, product.id, 2);
    await page.clock.runFor(30_000);

    const after = await api<Summary>(request, 'GET', '/dashboard/summary');
    expect(after.todaySales).toBeCloseTo(before.todaySales + 236, 2);
    await expect(tileValue(page, "Today's sales (net)")).toHaveText(formatMoney(after.todaySales));
    await expect(kpiValue(page, 'Net revenue')).toHaveText(formatMoney(after.todaySales));
  });

  test('while loading, cards show skeletons instead of claiming they are empty', async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/dashboard\/summary/, async (route: Route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/dashboard');
    await expect(page.getByText('Loading business day…')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    for (const claim of ['No invoices yet.', 'No payments taken yet today.', 'No shift is open for you right now.', 'Every product is above its reorder point.']) {
      await expect(page.getByText(claim)).toHaveCount(0);
    }
    release();
    await waitLoaded(page);
  });

  test('a failing endpoint only takes down its own cards', async ({ page }) => {
    const fail = (status: number) => (route: Route) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ statusCode: status, message: 'simulated' }) });

    // Summary down: banner + unavailable tiles; KPIs, chart and insights still render.
    await page.route(/\/api\/dashboard\/summary/, fail(500));
    await page.goto('/dashboard');
    await expect(page.getByText("Today's figures are unavailable")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('dl dt', { hasText: 'Net revenue' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI insights' })).toBeVisible();
    await expect(page.getByText('Unavailable').first()).toBeVisible();
    await expect(page.getByText('No shift is open for you right now.')).toHaveCount(0);
    await page.unroute(/\/api\/dashboard\/summary/);

    // KPIs and insights down: only those cards show their error.
    await page.route(/\/api\/dashboard\/kpis/, fail(503));
    await page.route(/\/api\/dashboard\/insights/, fail(503));
    await page.reload();
    await expect(page.getByText('KPIs unavailable')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Insights unavailable')).toBeVisible();
    await expect(page.getByText(/^Updated \d/)).toBeVisible();
    await expect(page.getByText("Today's figures are unavailable")).toHaveCount(0);
  });

  test('a malformed response is an error, never a dashboard of zeros', async ({ page }) => {
    await page.route(/\/api\/dashboard\/summary/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy error</html>' }));
    await page.goto('/dashboard');
    await expect(page.getByText("Today's figures are unavailable")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/unexpected response/)).toBeVisible();
  });

  test('a section the API reports as failed is marked unavailable, the rest stays', async ({ page }) => {
    await page.route(/\/api\/dashboard\/summary/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, failedSections: ['inventoryValue'], inventoryValue: null } });
    });
    await page.goto('/dashboard');
    await waitLoaded(page);
    await expect(page.getByLabel('Inventory value unavailable')).toBeVisible();
    await expect(page.getByText('Some figures are unavailable')).toBeVisible();
    await expect(page.getByLabel("Today's sales (net) unavailable")).toHaveCount(0);
  });

  test('polling: one request set per 30 s, paused while hidden; a hung request times out', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __hidden: boolean };
      w.__hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__hidden ? 'hidden' : 'visible') });
    });
    await page.clock.install();
    const calls = trackDashboardCalls(page);
    await page.goto('/dashboard');
    await waitLoaded(page);

    const base = calls.length;
    await page.clock.runFor(30_000);
    await expect.poll(() => calls.length - base).toBe(4);
    await page.clock.runFor(30_000);
    await expect.poll(() => calls.length - base).toBe(8);
    expect(calls.slice(base).sort()).toEqual(['insights', 'insights', 'kpis', 'kpis', 'summary', 'summary', 'trends', 'trends']);

    // Hidden: no polling; visible again: one immediate refresh.
    await page.evaluate(() => {
      (window as unknown as { __hidden: boolean }).__hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenBase = calls.length;
    await page.clock.runFor(120_000);
    expect(calls.length).toBe(hiddenBase);
    await page.evaluate(() => {
      (window as unknown as { __hidden: boolean }).__hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => calls.length - hiddenBase).toBe(4);

    // A hung summary request times out on its own (15 s, real time) into a visible
    // "showing last data" state; the next poll then tries again.
    let summaryRequests = 0;
    await page.route(/\/api\/dashboard\/summary/, () => {
      summaryRequests += 1; // never answered
    });
    await page.getByRole('button', { name: 'Refresh dashboard' }).click();
    await expect.poll(() => summaryRequests).toBe(1);
    await expect(page.getByText('Refresh failed — showing last data').first()).toBeVisible({ timeout: 30_000 });
    await page.clock.runFor(30_000);
    await expect.poll(() => summaryRequests).toBe(2);
  });
});

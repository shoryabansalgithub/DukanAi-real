import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Roadmap 6.7 in the browser: the forgot / reset password pages talk to the
 * API and never claim more than it did; the expenses tiles are the API's
 * month summary; an expense edit and a customer edit that clears fields both
 * persist; the inventory page carries no placeholder module; pinch-zoom is
 * allowed.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function tenDigits(): string {
  return String(7_000_000_000 + Math.floor(Math.random() * 999_999_999));
}

function modal(page: Page, title: string | RegExp) {
  return page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: title }) });
}

async function summary(request: APIRequestContext) {
  const res = await request.get(`${API_URL}/expenses/summary`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { paidThisMonth: number; pendingTotal: number; largestCategory: { category: string; amount: number } | null };
}

test.describe('forgot / reset password pages (6.7)', () => {
  test('the forgot page posts the address and shows the neutral confirmation', async ({ page, request }) => {
    // The login page links to it. Under the auth bypass the login page leaves for the dashboard as soon as
    // it hydrates, which raced a click on the link, so the link is read from the served markup.
    expect(await (await request.get('/login')).text()).toMatch(/<a[^>]*href="\/forgot-password"[^>]*>\s*Forgot\?/);
    await page.goto('/forgot-password');
    await page.getByLabel('Email Address').fill(`nobody-${Date.now().toString(36)}@example.com`);
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/auth/forgot-password'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    expect((await post).status()).toBe(200);
    await expect(page.getByTestId('reset-link-sent')).toContainText('If an account exists for that email');
  });

  test('the reset page refuses an incomplete link and a bad token, without a success message', async ({ page }) => {
    await page.goto('/reset-password');
    // Next's route announcer is also role=alert: filter on the message.
    await expect(page.getByRole('alert').filter({ hasText: 'This link is incomplete' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();

    await page.goto(`/reset-password?token=${'a'.repeat(64)}`);
    await page.getByLabel('New password').fill('Fresh-Password-1');
    await page.getByLabel('Confirm password').fill('Fresh-Password-1');
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/auth/reset-password'));
    await page.getByRole('button', { name: 'Change password' }).click();
    expect((await post).status()).toBe(400);
    await expect(page.getByRole('alert').filter({ hasText: 'invalid or has expired' })).toBeVisible();
    await expect(page.getByTestId('reset-done')).toHaveCount(0);
  });
});

test.describe('expenses (6.7)', () => {
  test('the tiles are the API month summary and an edit persists', async ({ page, request }) => {
    const description = unique('Tile expense');
    expect((await request.post(`${API_URL}/expenses`, { data: { description, category: 'Rent', amount: 1234.5 } })).status()).toBe(201);
    expect((await request.post(`${API_URL}/expenses`, { data: { description: unique('Unpaid expense'), category: 'Utilities', amount: 99, isPaid: false } })).status()).toBe(201);
    const expected = await summary(request);

    await page.goto('/expenses');
    await expect(page.getByTestId('expenses-paid-month')).toHaveText(`₹${expected.paidThisMonth.toLocaleString('en-IN')}`);
    await expect(page.getByTestId('expenses-pending')).toHaveText(`₹${expected.pendingTotal.toLocaleString('en-IN')}`);
    await expect(page.getByText('Module coming soon', { exact: false })).toHaveCount(0);

    const renamed = unique('Edited expense');
    await page.getByRole('button', { name: `Actions for ${description}` }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = modal(page, `Edit Expense: ${description}`);
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill(renamed);
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.includes('/expenses/'));
    await dialog.locator('button[type="submit"]').click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByText(`"${renamed}" updated`)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeVisible();
    const list = (await (await request.get(`${API_URL}/expenses?take=50`)).json()) as Array<{ description: string }>;
    expect(list.some((e) => e.description === renamed)).toBe(true);
    expect(list.some((e) => e.description === description)).toBe(false);
  });
});

test.describe('customer edit clears fields (6.7)', () => {
  test('emptying email and city persists as cleared', async ({ page, request }) => {
    const name = unique('Clearable customer');
    const created = await (await request.post(`${API_URL}/customers`, { data: { name, phone: tenDigits(), email: 'clear@example.com', city: 'Pune' } })).json();
    await page.goto('/customers');
    await page.getByLabel('Search customers').fill(name);
    await expect(page.getByRole('button', { name: `Actions for ${name}` })).toBeVisible();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Edit customer' }).click();
    await expect(page.getByLabel('Email')).toHaveValue('clear@example.com');
    await page.getByLabel('Email').fill('');
    await page.getByLabel('City').fill('');
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/customers/${created.id}`));
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByText('Customer updated')).toBeVisible();

    const stored = (await (await request.get(`${API_URL}/customers/${created.id}`)).json()) as { email: string | null; city: string | null; name: string };
    expect(stored.email ?? null).toBeNull();
    expect(stored.city ?? null).toBeNull();
    expect(stored.name).toBe(name);
  });
});

test.describe('inventory and viewport (6.7)', () => {
  test('the inventory page has no placeholder module and the viewport allows pinch-zoom', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.getByRole('heading', { name: 'Inventory Operations' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stock Transfer' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stock Adjustments' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Purchase Orders' })).toHaveCount(0);
    await expect(page.getByText('Module Coming Soon')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Adjust Stock on Products' })).toHaveAttribute('href', '/products');

    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\D|$)/);
  });
});

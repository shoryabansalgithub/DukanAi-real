import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import mysql from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Roadmap 6.9: the real sign-in flow (no bypass), every repaired page under a
 * real session, and role gating: a VIEWER sees no write buttons and the API
 * refuses the same writes anyway.
 */

const API_URL = `http://localhost:${process.env.E2E_AUTH_API_PORT ?? 3005}/api`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'mysql://root:password@localhost:3306/dukaanai_test';
const PASSWORD = 'Str0ng-Passw0rd!';

// bcrypt is the API's hashing library (hoisted to the workspace root); the VIEWER row is inserted directly.
const require = createRequire(__filename);
const bcrypt = require('bcrypt') as { hash(data: string, rounds: number): Promise<string> };

interface Owner {
  email: string;
  shopName: string;
}

function stamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

async function registerOwner(page: Page): Promise<Owner> {
  const id = stamp();
  const owner = { email: `owner-${id}@example.com`, shopName: `Real Auth Shop ${id}` };
  await page.goto('/register');
  await page.getByPlaceholder('Rajesh Kumar').fill('Real Owner');
  await page.getByPlaceholder('Kumar General Store').fill(owner.shopName);
  await page.getByPlaceholder('rajesh@example.com').fill(owner.email);
  await page.getByPlaceholder('Min. 8 characters').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Store' }).click();
  await page.waitForURL('**/dashboard');
  return owner;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('admin@dukaan.ai').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.locator('form button[type="submit"]').click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByTitle('Sign out').click();
  await page.waitForURL('**/login**');
  // The URL changes before NextAuth has finished clearing the session: wait until the session endpoint is empty,
  // or the next protected navigation can still carry the old cookie.
  await expect
    .poll(async () => page.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((s) => Boolean(s && s.user))))
    .toBe(false);
}

async function apiToken(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { access_token: string }).access_token;
}

test.describe('real sign-in (6.9)', () => {
  test('a visitor is bounced to /login with a callback; a wrong password is refused; the right one lands on the callback', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL('**/login?callbackUrl=%2Fdashboard');
    const response = await page.goto('/products');
    expect(response?.url()).toContain('/login?callbackUrl=%2Fproducts');

    const owner = await registerOwner(page);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await signOut(page);

    await page.goto('/products');
    await page.waitForURL('**/login?callbackUrl=%2Fproducts');
    await page.getByPlaceholder('admin@dukaan.ai').fill(owner.email);
    await page.getByPlaceholder('••••••••').fill('wrong-password');
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText('Invalid email or password', { exact: false })).toBeVisible();
    expect(page.url()).toContain('/login');

    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL('**/products');
    await expect(page.getByRole('heading', { name: 'Products & Stock' })).toBeVisible();
  });

  test('every repaired page renders under a real session', async ({ page }) => {
    await registerOwner(page);
    const pages: Array<[string, string]> = [
      ['/products', 'Products & Stock'],
      ['/settings', 'Settings'],
      ['/employees', 'Staff'],
      ['/suppliers', 'Suppliers & Vendors'],
      ['/smart-capture', 'Smart Bill Capture'],
      ['/ai-scanner', 'AI'],
      ['/customers', 'Customers'],
      ['/inventory', 'Inventory Operations'],
      ['/expenses', 'Expenses'],
      ['/invoices', 'Invoices'],
      ['/billing', 'Point of Sale'],
      ['/notifications', 'Notifications'],
      ['/shifts', 'Shift'],
      ['/analytics', 'Reports'],
    ];
    for (const [route, heading] of pages) {
      const response = await page.goto(route);
      expect(response?.status(), route).toBe(200);
      expect(new URL(page.url()).pathname, route).toBe(route);
      await expect(page.getByTestId('route-error'), route).toHaveCount(0);
      await expect(page.locator('h1').first(), route).toContainText(heading, { ignoreCase: true });
    }
  });

  test('a VIEWER sees no write buttons and the API refuses the same writes', async ({ page, request }) => {
    const owner = await registerOwner(page);
    const ownerToken = await apiToken(request, owner.email, PASSWORD);
    const shop = (await (await request.get(`${API_URL}/shops/me`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()) as { id: string };

    const viewerEmail = `viewer-${stamp()}@example.com`;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const conn = await mysql.createConnection(DATABASE_URL);
    try {
      await conn.execute(
        'INSERT INTO User (id, email, password, name, role, shopId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))',
        [`viewer-${stamp()}`, viewerEmail, hash, 'Read Only', 'VIEWER', shop.id],
      );
    } finally {
      await conn.end();
    }

    await signOut(page);
    await signIn(page, viewerEmail, PASSWORD);
    await page.waitForURL('**/dashboard');

    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'Products & Stock' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Product' })).toHaveCount(0);
    await page.goto('/employees');
    await expect(page.getByRole('button', { name: 'Invite Employee' })).toHaveCount(0);
    await page.goto('/suppliers');
    await expect(page.getByRole('heading', { name: 'Suppliers & Vendors' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Supplier' })).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Shop Profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    const viewerToken = await apiToken(request, viewerEmail, PASSWORD);
    const as = { headers: { Authorization: `Bearer ${viewerToken}` } };
    expect((await request.post(`${API_URL}/products`, { ...as, data: { name: 'Nope', costPrice: 1, sellingPrice: 2, mrp: 2, wholesalePrice: 2, unit: 'PCS' } })).status()).toBe(403);
    expect((await request.patch(`${API_URL}/shops/me`, { ...as, data: { name: 'Nope' } })).status()).toBe(403);
    expect((await request.post(`${API_URL}/invitations/generate`, { ...as, data: { email: 'x@example.com', role: 'CASHIER' } })).status()).toBe(403);
    expect((await request.post(`${API_URL}/suppliers`, { ...as, data: { name: 'Nope', phone: '9999999999' } })).status()).toBe(403);
    // Reads stay open to every signed-in role.
    expect((await request.get(`${API_URL}/products`, as)).status()).toBe(200);
  });

  test('ending another session from Account & Security revokes it on the API', async ({ page, request }) => {
    const owner = await registerOwner(page);
    // A second session with a recognisable user agent: the row reads "Firefox on Windows", the browser's own "Chrome on Linux".
    const other = await request.post(`${API_URL}/auth/login`, {
      data: { email: owner.email, password: PASSWORD },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0' },
    });
    expect(other.status(), await other.text()).toBe(201);
    const otherToken = ((await other.json()) as { access_token: string }).access_token;
    const asOther = { headers: { Authorization: `Bearer ${otherToken}` } };
    expect((await request.get(`${API_URL}/auth/profile`, asOther)).status()).toBe(200);

    await page.goto('/settings?section=account');
    await expect(page.getByRole('heading', { name: 'Account & Security' })).toBeVisible();
    const list = page.getByTestId('session-list');
    const row = list.locator('li', { hasText: 'Firefox on Windows' });
    await expect(row).toHaveCount(1);
    const revoked = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.includes('/auth/sessions/'));
    await row.getByRole('button', { name: 'End session' }).click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByText('Session ended')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Account & Security' })).toBeVisible();
    await expect(list.locator('li')).toHaveCount(1);
    await expect(list.locator('li', { hasText: 'Firefox on Windows' })).toHaveCount(0);
    expect((await request.get(`${API_URL}/auth/profile`, asOther)).status()).toBe(401);
    expect((await request.post(`${API_URL}/auth/refresh`, { data: { refresh_token: ((await other.json()) as { refresh_token: string }).refresh_token } })).status()).toBe(401);
  });

  test('the reset-password page changes the password through a real link, once, and the old password stops working', async ({ page, request }) => {
    const owner = await registerOwner(page);
    const newPassword = 'An0ther-Passw0rd!';
    // The link only ever reaches the user by email: the token row is written the way the API writes it (SHA-256 at rest).
    const rawToken = randomBytes(32).toString('hex');
    const conn = await mysql.createConnection(DATABASE_URL);
    try {
      const [rows] = await conn.execute('SELECT id FROM User WHERE email = ?', [owner.email]);
      const userId = (rows as Array<{ id: string }>)[0].id;
      await conn.execute(
        'INSERT INTO PasswordResetToken (id, userId, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL 1 HOUR), NULL, NOW(3))',
        [`prt-${stamp()}`, userId, createHash('sha256').update(rawToken).digest('hex')],
      );
    } finally {
      await conn.end();
    }

    await page.goto(`/reset-password?token=${rawToken}`);
    await page.locator('#reset-password').fill(newPassword);
    await page.locator('#reset-confirm').fill(newPassword);
    const reset = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/auth/reset-password'));
    await page.getByRole('button', { name: 'Change password' }).click();
    expect((await reset).status(), await (await reset).text()).toBe(200);
    await expect(page.getByTestId('reset-done')).toBeVisible();

    // Persisted: the old password is refused, the new one signs in, and the link is spent.
    expect((await request.post(`${API_URL}/auth/login`, { data: { email: owner.email, password: PASSWORD } })).status()).toBe(401);
    expect((await request.post(`${API_URL}/auth/reset-password`, { data: { token: rawToken, password: 'Third-Passw0rd!' } })).status()).toBe(400);
    await page.context().clearCookies();
    await signIn(page, owner.email, newPassword);
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

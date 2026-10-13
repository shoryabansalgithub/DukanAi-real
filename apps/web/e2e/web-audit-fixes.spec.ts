import { expect, test, type APIRequestContext } from '@playwright/test';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { csvCell } from '../src/lib/csv';

/**
 * The web findings of the 2026-10-11 release audit, in the browser (auth
 * bypass: the OWNER of its own shop). Each behaviour is checked after a
 * reload or against the API, never only through the page's own state. The
 * role gates (W12) and the labelled sign-in forms (W17) need real sessions:
 * e2e-auth/role-gates.spec.ts.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'mysql://root:password@localhost:3306/dukaanai_test';

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function tenDigits(): string {
  return String(8_000_000_000 + Math.floor(Math.random() * 999_999_999));
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, expected = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(expected);
  return (await res.json()) as T;
}

/** `X-Total-Count` of a capped list route. */
async function totalOf(request: APIRequestContext, path: string): Promise<number> {
  const res = await request.get(`${API_URL}${path}${path.includes('?') ? '&' : '?'}take=1`);
  expect(res.status()).toBe(200);
  return Number(res.headers()['x-total-count']);
}

/** Every row of a capped list route, page by page. */
async function everyRow<T>(request: APIRequestContext, path: string): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const page = await json<T[]>(await request.get(`${API_URL}${path}?skip=${rows.length}&take=200`));
    rows.push(...page);
    if (page.length < 200) return rows;
  }
}

const isPath = (suffix: string) => (r: { url(): string }) => new URL(r.url()).pathname.endsWith(suffix);

/** `GET /shifts/current` answers an empty body when the actor has no open shift. */
async function hasOpenShift(request: APIRequestContext): Promise<boolean> {
  return (await (await request.get(`${API_URL}/shifts/current`)).text()).trim().startsWith('{');
}

/** The business date of `now` in `timeZone`, as the API computes it. */
function dateIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

test.describe('W5 / W6: the drawer is counted, in paise', () => {
  test('an empty counted cash is refused; paise open and close the shift', async ({ page, request }) => {
    if (await hasOpenShift(request)) {
      expect([200, 201]).toContain((await request.post(`${API_URL}/shifts/current/close`, { data: { closingCash: 0 } })).status());
    }
    await page.goto('/shifts');
    await page.getByRole('button', { name: 'Open shift' }).click();
    // step="0.01": the browser accepts paise (a form the browser refuses never sends the request).
    await page.locator('#opening-cash').fill('250.75');
    const opened = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/shifts/open')(r));
    await page.locator('form').getByRole('button', { name: 'Open shift' }).click();
    expect((await opened).status()).toBe(201);
    await expect(page.getByText('Shift open', { exact: true })).toBeVisible();

    let closes = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && isPath('/shifts/current/close')(r)) closes += 1;
    });
    await page.getByRole('button', { name: 'Close shift' }).click();
    const form = page.locator('form').filter({ has: page.locator('#closing-cash') });
    await expect(page.locator('#closing-cash')).toHaveValue('');
    await form.getByRole('button', { name: 'Close shift' }).click();
    await expect(form.getByRole('alert')).toHaveText('Enter the cash counted in the drawer (0 or more).');
    expect(closes).toBe(0);
    expect(await hasOpenShift(request)).toBe(true);

    await page.locator('#closing-cash').fill('250.25');
    const closed = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/shifts/current/close')(r));
    await form.getByRole('button', { name: 'Close shift' }).click();
    const response = await closed;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ closingCash: 250.25 });
    const shifts = await json<{ items: Array<{ openingCash: string | number; closingCash: string | number | null }> }>(await request.get(`${API_URL}/shifts?take=1`));
    expect(Number(shifts.items[0].openingCash)).toBe(250.75);
    expect(Number(shifts.items[0].closingCash)).toBe(250.25);
    expect(await hasOpenShift(request)).toBe(false);
  });
});

test.describe('W8: Smart Capture finds any customer', () => {
  test('a customer past the newest 25 is found by searching the API and the bill is filed under it', async ({ page, request }) => {
    const target = await json<{ id: string; name: string }>(await request.post(`${API_URL}/customers`, { data: { name: unique('Old capture customer'), phone: tenDigits() } }), 201);
    // 26 newer customers push the target out of the newest 25 the old picker loaded.
    for (let i = 0; i < 26; i += 1) {
      await json(await request.post(`${API_URL}/customers`, { data: { name: unique('Newer customer'), phone: tenDigits() } }), 201);
    }
    await page.goto('/smart-capture');
    const picker = page.getByLabel('Select Customer (Optional)');
    const searched = page.waitForResponse((r) => isPath('/customers')(r) && new URL(r.url()).searchParams.get('q') === target.name);
    await picker.fill(target.name);
    expect((await searched).status()).toBe(200);
    await page.getByRole('option', { name: target.name }).click();
    await expect(picker).toHaveValue(target.name);
    await expect(page.getByText(`Customers › ${target.name} › Bills`)).toBeVisible();

    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 120;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 200, 120);
      ctx.fillStyle = '#111';
      ctx.fillText('Bill 1 x Tea 10.00', 10, 60);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    await page.getByTestId('gallery-input').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
    const stored = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.includes(`/storage/bills/${target.id}/`));
    await page.getByRole('button', { name: 'Save Original Photo' }).click();
    expect((await stored).status()).toBe(201);
    await expect(page.getByTestId('capture-success')).toContainText(`Original photo stored under ${target.name} › Bills › BILL-`);

    // Walk-in is the first option and clears the link.
    await picker.click();
    await page.getByRole('option', { name: 'Walk-in / General Upload' }).click();
    await expect(picker).toHaveValue('');
  });

  test('the camera is stopped when it answers after the capture was closed or the page left (W18)', async ({ page }) => {
    await page.addInitScript(() => {
      const state: { resolvers: Array<() => void>; streams: MediaStream[] } = { resolvers: [], streams: [] };
      (window as unknown as { __camera: typeof state }).__camera = state;
      navigator.mediaDevices.getUserMedia = () =>
        new Promise<MediaStream>((resolve) => {
          state.resolvers.push(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 4;
            canvas.height = 4;
            canvas.getContext('2d')!.fillRect(0, 0, 4, 4);
            const stream = canvas.captureStream();
            state.streams.push(stream);
            resolve(stream);
          });
        });
    });
    const answer = () => page.evaluate(() => (window as unknown as { __camera: { resolvers: Array<() => void> } }).__camera.resolvers.shift()?.());
    const liveTracks = () =>
      page.evaluate(() => (window as unknown as { __camera: { streams: MediaStream[] } }).__camera.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);

    await page.goto('/smart-capture');
    // Closed while the permission prompt is open.
    await page.getByRole('heading', { name: 'Open Mobile Camera' }).click();
    await page.getByRole('button', { name: 'Close camera' }).click();
    await answer();
    await expect.poll(liveTracks).toBe(0);

    // Left while the prompt is open (a client-side navigation keeps the window).
    await page.getByRole('heading', { name: 'Open Mobile Camera' }).click();
    // The capture overlay covers the sidebar: dispatch the click to the link itself.
    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().dispatchEvent('click');
    await page.waitForURL('**/dashboard');
    await answer();
    await expect.poll(liveTracks).toBe(0);
  });
});

test.describe('W9: lists are never cut silently', () => {
  test('inventory tiles and search cover every batch, the table pages through them', async ({ page, request }) => {
    const product = await json<{ id: string }>(
      await request.post(`${API_URL}/products`, { data: { name: unique('Batch item'), unit: 'PCS', gstRate: 'ZERO', costPrice: 10, sellingPrice: 20, mrp: 20 } }),
      201,
    );
    // Past two API pages of 200, so the client has to read three.
    const missing = Math.max(0, 402 - (await totalOf(request, '/batches')));
    const stamp = Date.now().toString(36);
    for (let i = 0; i < missing; i += 1) {
      await json(await request.post(`${API_URL}/batches`, { data: { productId: product.id, batchNumber: `W9-${stamp}-${i}`, type: 'PURCHASE' } }), 201);
    }
    // Sorted last by the API (latest expiry): on its last page.
    const late = `W9-LATE-${stamp}`;
    await json(await request.post(`${API_URL}/batches`, { data: { productId: product.id, batchNumber: late, type: 'PURCHASE', expiryDate: '2099-12-31' } }), 201);
    const all = await everyRow<{ batchNo: string; quantity: number }>(request, '/batches');
    expect(all.length).toBeGreaterThan(400);

    const reads: string[] = [];
    page.on('request', (r) => {
      if (isPath('/batches')(r)) reads.push(new URL(r.url()).search);
    });
    await page.goto('/inventory');
    await expect(page.getByText(`of ${all.length.toLocaleString('en-IN')} batches`)).toBeVisible();
    expect(reads).toEqual(expect.arrayContaining(['?skip=0&take=200', '?skip=200&take=200', '?skip=400&take=200']));
    const empty = all.filter((b) => b.quantity === 0).length;
    await expect(page.getByText('Empty Batches').locator('xpath=..').getByRole('heading')).toHaveText(String(empty));

    await page.getByPlaceholder('Search by product, batch no, or SKU...').fill(late);
    await expect(page.getByText(late)).toBeVisible();
    await page.getByPlaceholder('Search by product, batch no, or SKU...').fill('');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(`51–100`)).toBeVisible();
  });

  test('every employee is listed, past the first page of 100', async ({ page, request }) => {
    const shop = await json<{ id: string }>(await request.get(`${API_URL}/shops/me`));
    const missing = Math.max(0, 102 - (await totalOf(request, '/users/employees')));
    const stamp = Date.now().toString(36);
    if (missing > 0) {
      const conn = await mysql.createConnection(DATABASE_URL);
      try {
        for (let i = 0; i < missing; i += 1) {
          const id = `w9-${stamp}-${i}`;
          // "Zz" sorts last by name: these rows are on the API's second page.
          await conn.execute(
            'INSERT INTO User (id, email, password, name, role, shopId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))',
            [id, `${id}@example.com`, 'x', `Zz W9 staff ${stamp} ${String(i).padStart(3, '0')}`, 'VIEWER', shop.id],
          );
        }
      } finally {
        await conn.end();
      }
    }
    const everyone = await everyRow<{ id: string; name: string }>(request, '/users/employees');
    expect(everyone.length).toBeGreaterThan(100);
    const lastByName = everyone[everyone.length - 1];

    await page.goto('/employees');
    await expect(page.getByText('Total Staff').locator('xpath=..').getByRole('heading')).toHaveText(String(everyone.length));
    await page.getByPlaceholder('Search by name, email or phone...').fill(lastByName.name);
    await expect(page.getByTestId(`employee-row-${lastByName.id}`)).toBeVisible();
  });

  test('notifications load past the first 100 on request', async ({ page, request }) => {
    const missing = Math.max(0, 103 - (await totalOf(request, '/notifications')));
    for (let i = 0; i < missing; i += 1) {
      await json(await request.post(`${API_URL}/notifications`, { data: { type: 'PAYMENT_RECEIVED', title: `W9 notice ${i}`, message: 'Seeded by the W9 test' } }), 201);
    }
    const total = await totalOf(request, '/notifications');
    expect(total).toBeGreaterThan(100);

    await page.goto('/notifications');
    const items = page.locator('main').getByRole('heading', { level: 4 });
    await expect(items).toHaveCount(100);
    const more = page.getByRole('button', { name: `Load more (100 of ${total} shown)` });
    await expect(more).toBeVisible();
    const read = page.waitForResponse((r) => isPath('/notifications')(r) && new URL(r.url()).searchParams.get('skip') === '100');
    await more.click();
    expect((await read).status()).toBe(200);
    await expect(items).toHaveCount(Math.min(total, 200));
  });
});

test.describe('W11 / W16: exports and "today" follow the shop, not the browser', () => {
  test('the invoices filter and the export window are the shop business dates in a far-away browser', async ({ browser, request, baseURL }) => {
    const shop = await json<{ settings?: { timezone?: string } }>(await request.get(`${API_URL}/shops/me`));
    const shopZone = shop.settings?.timezone ?? 'Asia/Kolkata';
    const today = dateIn(shopZone);
    // A browser whose own date differs from the shop's right now (one of the two always does).
    const timezoneId = ['Pacific/Pago_Pago', 'Pacific/Kiritimati'].find((zone) => dateIn(zone) !== today)!;
    const context = await browser.newContext({ timezoneId, baseURL });
    const page = await context.newPage();
    try {
      await page.goto('/invoices');
      await expect(page.getByLabel('From', { exact: true })).toHaveValue(today);
      await expect(page.getByLabel('To', { exact: true })).toHaveValue(today);
      await expect(page.getByPlaceholder('e.g. INV-2627-000123')).toBeVisible();

      const window = await json<{ from: string; to: string }>(await request.get(`${API_URL}/dashboard/analytics?range=week`));
      expect(window.to).toBe(today);
      // A slow export (16 s, past the old 15 s default) still downloads, for the API's own window.
      await page.route(/\/dashboard\/export\/invoices\.csv/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 16_000));
        await route.fulfill({ status: 200, contentType: 'text/csv', body: 'invoice_number\nINV-2627-000001\n' });
      });
      await page.goto('/analytics');
      await expect(page.getByRole('heading', { name: 'Reports & Analytics' })).toBeVisible();
      await page.getByRole('button', { name: 'Export' }).click();
      const asked = page.waitForRequest(/\/dashboard\/export\/invoices\.csv/);
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('menuitem', { name: /Invoices/ }).click();
      const params = new URL((await asked).url()).searchParams;
      expect({ from: params.get('from'), to: params.get('to') }).toEqual({ from: window.from, to: window.to });
      expect((await download).suggestedFilename()).toBe(`invoices_${window.from}_to_${window.to}.csv`);
      await expect(page.getByText('Invoices export downloaded')).toBeVisible();

      // A refused export says why: the API's message, read out of the blob body.
      await page.unroute(/\/dashboard\/export\/invoices\.csv/);
      await page.route(/\/dashboard\/export\/invoice-items\.csv/, (route) =>
        route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ statusCode: 400, code: 'EXPORT_RANGE_TOO_LONG', message: 'The export range is too long.' }) }),
      );
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: /Invoice items/ }).click();
      // The toast container is a polite live region; an error toast is an alert (W17).
      await expect(page.getByRole('alert').filter({ hasText: 'The export range is too long.' })).toBeVisible();
      await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

test.describe('W14: the OCR CSV never carries a live formula', () => {
  test('csvCell guards formula starts and leaves plain numbers alone', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+91 tea')).toBe("'+91 tea");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('+3')).toBe('+3');
    expect(csvCell('Maggi, 140g')).toBe('"Maggi, 140g"');
    expect(csvCell(null)).toBe('');
  });

  test('the scanner export guards what was read off the photo', async ({ page }) => {
    const item = (rawName: string, price: number | null) => ({ rawName, qty: 1, price, matchedSku: null, matchedName: null, matchedProductSku: null, dbPrice: null, confidence: 0 });
    const matchedItems = [item('=HYPERLINK("http://evil","x")', 10), item('@SUM(A1)', -5), item('Chai', 20)];
    await page.route(/\/ocr\/scan-bill$/, (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'Read', documentType: 'BILL', mimeType: 'image/jpeg', preview: { parsedData: { items: matchedItems }, matchedItems } }),
      }),
    );
    await page.goto('/ai-scanner');
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    await page.getByTestId('scan-input').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
    await expect(page.getByTestId('scan-result')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).first().click();
    const file = await (await download).path();
    const lines = fs.readFileSync(file!, 'utf8').split('\n');
    expect(lines[1].startsWith(`"'=HYPERLINK(""http://evil"",""x"")",1,10,`)).toBe(true);
    expect(lines[2].startsWith("'@SUM(A1),1,-5,")).toBe(true);
    expect(lines[3].startsWith('Chai,1,20,')).toBe(true);
  });
});

test.describe('W15: the invoice page after a cancel', () => {
  test('shows the whole document again (shift, lines) without a reload', async ({ page, request }) => {
    if (!(await hasOpenShift(request))) await json(await request.post(`${API_URL}/shifts/open`, { data: { openingCash: 0 } }), 201);
    const product = await json<{ id: string }>(
      await request.post(`${API_URL}/products`, { data: { name: unique('Cancel item'), type: 'SERVICE', unit: 'PCS', gstRate: 'ZERO', costPrice: 40, sellingPrice: 100, mrp: 100 } }),
      201,
    );
    const sale = await json<{ invoice: { id: string; invoiceNumber: string } }>(
      await request.post(`${API_URL}/billing/invoice`, { data: { idempotencyKey: randomUUID(), items: [{ productId: product.id, quantity: 1 }], payments: [{ tender: 'CASH', amount: 100 }], udharAmount: 0 } }),
      201,
    );
    await page.goto(`/invoices/${sale.invoice.id}`);
    await expect(page.getByText('· shift open', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByLabel('Cancellation reason').fill('Rang up the wrong item');
    const reread = page.waitForResponse((r) => r.request().method() === 'GET' && isPath(`/billing/invoices/${sale.invoice.id}`)(r));
    await page.getByRole('button', { name: 'Cancel invoice' }).click();
    expect((await reread).status()).toBe(200);
    await expect(page.getByText(`Invoice ${sale.invoice.invoiceNumber} cancelled`)).toBeVisible();
    await expect(page.getByText('· shift open', { exact: false })).toBeVisible();
    await expect(page.getByText('no shift', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  });
});

test.describe('W17 / W18: accessible chrome, storage that refuses', () => {
  test('modal and panel close buttons are named', async ({ page }) => {
    await page.goto('/customers');
    await page.getByRole('button', { name: 'Add customer' }).first().click();
    await expect(page.getByRole('heading', { name: 'Add new customer' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add new customer' })).toHaveCount(0);
  });

  test('the theme switch works when the browser refuses localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === 'theme') throw new DOMException('The operation is insecure.', 'SecurityError');
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'theme') throw new DOMException('The operation is insecure.', 'SecurityError');
        return setItem.call(this, key, value);
      };
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('route-error')).toHaveCount(0);
    const html = page.locator('html');
    const wasDark = ((await html.getAttribute('class')) ?? '').includes('dark');
    await page.getByRole('button', { name: wasDark ? 'Switch to light theme' : 'Switch to dark theme' }).click();
    if (wasDark) await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    else await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  });
});

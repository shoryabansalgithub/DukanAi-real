import { devices, expect, test, type APIRequestContext, type CDPSession, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { money } from '../src/components/pos/format';

/**
 * Pilot pre-flight (roadmap 9.19): what the pilot shop's hardware and network
 * do to the web app, emulated before the shop meets it.
 *
 *  - a USB barcode scanner is a keyboard: a burst of keystrokes a few ms apart
 *    and an Enter, wherever the focus happens to be;
 *  - the receipt goes to an 80 mm thermal printer through the browser's print
 *    dialog (72 mm printable), from a device that may be in dark mode;
 *  - the cashier works on a tablet or a phone, the owner reads the dashboard
 *    on a phone;
 *  - the shop's mobile network is slow and drops answers;
 *  - bills are photographed with phone cameras (12 to 200 megapixels).
 *
 * Each test states what the shop needs; docs/PILOT.md lists the defects the
 * first run of this file found and the checklist the shop runs on the real
 * hardware afterwards.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'mysql://root:password@localhost:3306/dukaanai_test';

interface CreatedProduct {
  id: string;
  name: string;
  barcode: string;
}

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  totalAmount: string | number;
  cgstAmount: string | number;
  sgstAmount: string | number;
  items: Array<{ id: string; productId: string | null }>;
}

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** A 13-digit numeric code, like the EAN-13 on most packaged goods. */
function ean(): string {
  return `89${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

async function json<T>(res: { status(): number; text(): Promise<string> }, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status(), text).toBe(status);
  return JSON.parse(text) as T;
}

async function createProduct(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<CreatedProduct> {
  const name = (overrides.name as string | undefined) ?? unique('Pilot item');
  const barcode = (overrides.barcode as string | undefined) ?? ean();
  const body = await json<{ id: string }>(
    await request.post(`${API_URL}/products`, {
      data: {
        name,
        barcode,
        type: 'SERVICE',
        unit: 'PCS',
        gstRate: 'EIGHTEEN',
        costPrice: 60,
        sellingPrice: 118,
        mrp: 118,
        wholesalePrice: 100,
        ...overrides,
      },
    }),
    201,
  );
  return { id: body.id, name, barcode };
}

/** A cash sale through the API, paid exactly (the total comes from the API's own preview). */
async function apiSale(request: APIRequestContext, productId: string, quantity = 1): Promise<ApiInvoice> {
  const items = [{ productId, quantity }];
  // The engine's `finalTotal` is the payable amount (after the round-off).
  const preview = await json<{ finalTotal: number | string }>(await request.post(`${API_URL}/billing/calculate`, { data: { items } }), 200);
  const total = Number(preview.finalTotal);
  expect(Number.isFinite(total) && total > 0, JSON.stringify(preview)).toBe(true);
  const created = await json<{ invoice: ApiInvoice }>(
    await request.post(`${API_URL}/billing/invoice`, { data: { idempotencyKey: randomUUID(), items, payments: [{ tender: 'CASH', amount: total }] } }),
    201,
  );
  return created.invoice;
}

async function ensureOpenShift(request: APIRequestContext): Promise<void> {
  const current = (await (await request.get(`${API_URL}/shifts/current`)).text()).trim();
  if (current.startsWith('{')) return;
  await json(await request.post(`${API_URL}/shifts/open`, { data: { openingCash: 0 } }), 201);
}

async function openPos(page: Page): Promise<void> {
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  // The heading and search box are server-rendered: the page listens for the
  // scanner only once React has hydrated it, and the product grid is loaded by
  // the client after that (every test creates a product first).
  await expect(page.locator('#pos-product-results [role="option"]').first()).toBeVisible();
}

const cdpSessions = new WeakMap<Page, CDPSession>();

async function cdpOf(page: Page): Promise<CDPSession> {
  let session = cdpSessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    cdpSessions.set(page, session);
  }
  return session;
}

/**
 * What a USB (HID keyboard-wedge) scanner sends: the characters 8 ms apart and
 * an Enter, all queued at once, each key stamped with its arrival time the way
 * the OS stamps a real scanner's keys. The page handles them as fast as it
 * renders, so a busy page handles them far apart, as on a slow tablet.
 * Playwright's `keyboard.type` waits for the page between keys, which no
 * scanner does.
 */
async function scan(page: Page, code: string): Promise<void> {
  const cdp = await cdpOf(page);
  const start = Date.now() / 1000;
  const keyOf = (ch: string) =>
    ch === '\r'
      ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      : { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
  await Promise.all(
    [...code, '\r'].flatMap((ch, i) => {
      const at = start + (i * 8) / 1000;
      const key = keyOf(ch);
      return [
        cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: ch, unmodifiedText: ch, timestamp: at }),
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, timestamp: at + 0.003 }),
      ];
    }),
  );
}

/**
 * Puts a product in the cart the way a cashier taps it, without the scanner:
 * a test about one scanner situation (or about the network) must not depend
 * on an earlier scan.
 */
async function addFromGrid(page: Page, name: string): Promise<void> {
  await page.getByTestId('pos-search').fill(name);
  await page.locator('#pos-product-results [role="option"]', { hasText: name }).first().click();
}

function cartLine(page: Page, name: string) {
  return page.locator('[data-testid="cart-line"][data-custom="false"]', { hasText: name });
}

function parseMoney(text: string): number {
  const value = Number(text.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(value)) throw new Error(`Not a money string: "${text}"`);
  return value;
}

test.describe('USB barcode scanner at the POS', () => {
  test('a scan adds the product, a second scan adds one more', async ({ page, request }) => {
    const product = await createProduct(request);
    await openPos(page);
    await scan(page, product.barcode);
    const line = cartLine(page, product.name);
    await expect(line).toHaveCount(1);
    await scan(page, product.barcode);
    await expect(line.getByRole('spinbutton', { name: /^Quantity of/ })).toHaveValue('2');
  });

  test('a scan on a slow tablet (CPU at a sixth of the speed) still adds the product', async ({ page, request }) => {
    const product = await createProduct(request);
    await openPos(page);
    await page.getByTestId('pos-search').focus();
    // Each key typed into the search box re-renders the POS: here that takes far longer than the scanner's 8 ms.
    await (await cdpOf(page)).send('Emulation.setCPUThrottlingRate', { rate: 6 });
    try {
      await scan(page, product.barcode);
      await expect(cartLine(page, product.name)).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await (await cdpOf(page)).send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
  });

  test('a scan while the shop is still loading on a weak network is added once it has loaded', async ({ page, request }) => {
    const product = await createProduct(request);
    // GET /shops/me answers 4 s late: the POS is on screen but not yet scoped to the shop.
    await page.route(/\/api\/shops\/me$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
    await openPos(page);
    await scan(page, product.barcode);
    await expect(page.getByText(`Scanned ${product.barcode}: it is added as soon as the shop has loaded`)).toBeVisible();
    await expect(cartLine(page, product.name)).toHaveCount(1, { timeout: 20_000 });
  });

  test('a scan while the notes field has focus adds the product and leaves the notes as typed', async ({ page, request }) => {
    const product = await createProduct(request);
    const first = await createProduct(request);
    await openPos(page);
    await addFromGrid(page, first.name);
    await expect(cartLine(page, first.name)).toHaveCount(1);

    const notes = page.getByLabel('Invoice notes');
    await notes.click();
    await notes.pressSequentially('deliver at 5', { delay: 120 });
    await scan(page, product.barcode);

    await expect(cartLine(page, product.name)).toHaveCount(1);
    await expect(notes).toHaveValue('deliver at 5');
  });

  test('a scan while the payment panel is open never confirms the sale', async ({ page, request }) => {
    const product = await createProduct(request);
    await openPos(page);
    await addFromGrid(page, product.name);
    await expect(cartLine(page, product.name)).toHaveCount(1);

    let posted = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/billing/invoice')) posted += 1;
    });
    await page.getByTestId('pos-charge').click();
    const cash = page.getByTestId('cash-tendered');
    await expect(cash).toBeFocused();
    const before = await cash.inputValue();

    // A short shop-printed code would otherwise be taken as cash tendered and the sale confirmed.
    await scan(page, '4711');
    await page.waitForTimeout(1500);

    expect(posted).toBe(0);
    await expect(page.getByTestId('payment-confirm')).toBeVisible();
    await expect(cash).toHaveValue(before);
  });

  test('a scan on the last sale\'s receipt starts the next sale with that product', async ({ page, request }) => {
    const sold = await createProduct(request);
    const next = await createProduct(request);
    await openPos(page);
    await addFromGrid(page, sold.name);
    await expect(cartLine(page, sold.name)).toHaveCount(1);
    await page.getByTestId('pos-charge').click();
    const due = parseMoney(await page.getByTestId('payment-amount-due').innerText());
    await page.getByTestId('cash-tendered').fill(String(Math.ceil(due)));
    await page.getByTestId('payment-confirm').click();
    await expect(page.getByTestId('receipt-modal')).toBeVisible();

    await scan(page, next.barcode);

    await expect(page.getByTestId('receipt-modal')).toBeHidden();
    await expect(cartLine(page, next.name)).toHaveCount(1);
    await expect(cartLine(page, sold.name)).toHaveCount(0);
  });

  test('a barcode that two products share can be resolved and sold', async ({ page, request }) => {
    const code = ean();
    const owner = await createProduct(request, { barcode: code });
    const other = await createProduct(request, { barcode: ean() });
    // The same code as an alternate barcode of another product (an import or a supplier relabel).
    const conn = await mysql.createConnection(DATABASE_URL);
    try {
      const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT shopId FROM Product WHERE id = ?', [other.id]);
      await conn.execute('INSERT INTO ProductBarcode (id, productId, shopId, barcode, type, isPrimary, isActive) VALUES (?, ?, ?, ?, ?, 0, 1)', [
        `pilot${Date.now().toString(36)}`,
        other.id,
        rows[0].shopId,
        code,
        'EAN13',
      ]);
    } finally {
      await conn.end();
    }

    await openPos(page);
    await scan(page, code);
    const picker = page.getByRole('dialog').filter({ hasText: 'Which product?' });
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(owner.name);
    await expect(picker).toContainText(money(118));
    await picker.getByRole('button', { name: new RegExp(other.name) }).click();
    await expect(cartLine(page, other.name)).toHaveCount(1);
  });
});

test.describe('80 mm thermal receipt', () => {
  test('the printed receipt carries the stored CGST and SGST', async ({ page, request }) => {
    const product = await createProduct(request);
    const invoice = await apiSale(request, product.id, 2);
    expect(Number(invoice.cgstAmount)).toBeGreaterThan(0);

    await page.goto(`/invoices/${invoice.id}/receipt`);
    const paper = page.locator('.receipt-paper');
    await expect(paper).toContainText(invoice.invoiceNumber);
    await expect(paper.locator('div', { hasText: /^CGST/ }).last()).toContainText(money(Number(invoice.cgstAmount)));
    await expect(paper.locator('div', { hasText: /^SGST/ }).last()).toContainText(money(Number(invoice.sgstAmount)));
  });

  test('a return receipt names the invoice it reverses', async ({ page, request }) => {
    await ensureOpenShift(request);
    const product = await createProduct(request);
    const sale = await apiSale(request, product.id, 1);
    const created = await json<{ invoice: { id: string } }>(
      await request.post(`${API_URL}/billing/returns`, {
        data: { idempotencyKey: randomUUID(), invoiceId: sale.id, items: [{ invoiceItemId: sale.items[0].id, quantity: 1 }], reason: 'DAMAGED', refund: { tender: 'CASH' } },
      }),
      201,
    );

    await page.goto(`/invoices/${created.invoice.id}/receipt`);
    const paper = page.locator('.receipt-paper');
    await expect(paper).toContainText('SALES RETURN');
    await expect(paper).toContainText(sale.invoiceNumber);
  });

  test('long names and large amounts stay inside the 72 mm printable width', async ({ page, request }) => {
    const product = await createProduct(request, {
      name: unique('Fortune Sunlite Refined Sunflower Oil Pouch 1 Litre (Pack of 12) Family Saver'),
      sellingPrice: 98765.43,
      mrp: 98765.43,
      costPrice: 50000,
      wholesalePrice: 90000,
    });
    const invoice = await apiSale(request, product.id, 3);

    await page.goto(`/invoices/${invoice.id}/receipt`);
    await expect(page.locator('.receipt-paper')).toContainText(invoice.invoiceNumber);
    await page.emulateMedia({ media: 'print' });

    const layout = await page.evaluate(() => {
      const paper = document.querySelector('.receipt-paper') as HTMLElement;
      const box = paper.getBoundingClientRect();
      const mmPerPx = 25.4 / 96;
      const overflowing = Array.from(paper.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.getBoundingClientRect().width > 0)
        .filter((el) => el.getBoundingClientRect().right > box.right + 0.5 || el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
      const visibleOutside = Array.from(document.body.children).filter(
        (el) => !el.classList.contains('receipt-print-root') && getComputedStyle(el).display !== 'none',
      ).length;
      return { widthMm: box.width * mmPerPx, overflowing, visibleOutside };
    });
    expect(layout.widthMm).toBeLessThanOrEqual(72.5);
    expect(layout.overflowing).toEqual([]);
    expect(layout.visibleOutside).toBe(0);
  });

  test('a device in dark mode still prints dark text on the paper', async ({ browser, request }) => {
    const product = await createProduct(request);
    const invoice = await apiSale(request, product.id, 1);
    const context = await browser.newContext({ colorScheme: 'dark' });
    try {
      const page = await context.newPage();
      await page.goto(`/invoices/${invoice.id}/receipt`);
      await expect(page.locator('.receipt-paper')).toContainText(invoice.invoiceNumber);
      await expect(page.locator('html')).toHaveClass(/dark/);

      // What the browser does around window.print(): beforeprint, the print rendering, afterprint.
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await page.emulateMedia({ media: 'print' });
      const lightText = await page.evaluate(() => {
        const luminance = (rgb: string) => {
          const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.receipt-paper *'))
          .filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()))
          .filter((el) => luminance(getComputedStyle(el).color) > 0.5)
          .map((el) => `${(el.textContent ?? '').trim().slice(0, 30)} (${getComputedStyle(el).color})`);
      });
      expect(lightText).toEqual([]);

      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await expect(page.locator('html')).toHaveClass(/dark/);
    } finally {
      await context.close();
    }
  });
});

// A device profile without `defaultBrowserType`, which Playwright allows only at the top level.
function phone(name: keyof typeof devices) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name];
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
}

test.describe('the cashier on a phone', () => {
  test.use(phone('Pixel 7'));

  test('the menu starts closed, so the POS is what the cashier sees', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
    const menu = page.getByRole('button', { name: /menu/i });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    const search = await page.getByTestId('pos-search').boundingBox();
    const viewport = page.viewportSize();
    expect(search && viewport && search.x >= 0 && search.x + search.width <= viewport.width).toBeTruthy();
    await expect(page.locator('aside').first()).not.toBeInViewport();
  });
});

test.describe("the owner's phone", () => {
  test.use(phone('Pixel 7'));

  test('the dashboard shows the API\'s figures, a tap refreshes it and the page never scrolls sideways', async ({ page, request }) => {
    await page.goto('/dashboard');
    await expect(page.getByText(/^Updated \d/)).toBeVisible({ timeout: 60_000 });
    const summary = await json<{ todayOrders: number; failedSections: string[] }>(await request.get(`${API_URL}/dashboard/summary`), 200);
    expect(summary.failedSections).toEqual([]);
    const orders = page.locator('p', { hasText: /^Today's orders$/ }).locator('xpath=following-sibling::h3[1]');
    await expect(orders).toHaveText(summary.todayOrders.toLocaleString('en-IN'));

    // A thumb reaches the refresh button: nothing (an open menu's overlay) covers it.
    const refreshed = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/dashboard/summary'));
    await page.getByRole('button', { name: 'Refresh dashboard' }).tap({ timeout: 10_000 });
    await refreshed;

    // The page itself is never wider than the phone (L-03 is about figures cut inside their tiles).
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});

test.describe('a weak mobile network at checkout', () => {
  test('an answer lost on the way back is retried with the same key and bills once', async ({ page, request }) => {
    const product = await createProduct(request);
    await openPos(page);
    await addFromGrid(page, product.name);
    await expect(cartLine(page, product.name)).toHaveCount(1);

    const keys: string[] = [];
    let lost = false;
    await page.route(/\/api\/billing\/invoice$/, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey);
      if (!lost) {
        lost = true;
        // The request reaches the API and the sale commits; the answer never reaches the tablet.
        await route.fetch();
        return route.abort('connectionreset');
      }
      return route.continue();
    });

    await page.getByTestId('pos-charge').click();
    const due = parseMoney(await page.getByTestId('payment-amount-due').innerText());
    await page.getByTestId('cash-tendered').fill(String(Math.ceil(due)));
    await page.getByTestId('payment-confirm').click();
    await expect(page.getByText('retrying will not create a duplicate bill', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();

    const receipt = page.getByTestId('receipt-modal');
    await expect(receipt).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    const invoiceId = (await receipt.getAttribute('data-invoice-id')) as string;
    // The product is new to this test: every invoice line that sells it was written by these two requests.
    const conn = await mysql.createConnection(DATABASE_URL);
    try {
      const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT DISTINCT invoiceId FROM InvoiceItem WHERE productId = ?', [product.id]);
      expect(rows.map((r) => r.invoiceId)).toEqual([invoiceId]);
    } finally {
      await conn.end();
    }
  });

  test('a sale on a slow 3G link completes', async ({ page, request }) => {
    const product = await createProduct(request);
    await openPos(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    // Chrome's "Slow 3G" profile: 400 ms round trip, about 400 kbit/s each way.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
    await addFromGrid(page, product.name);
    await expect(cartLine(page, product.name)).toHaveCount(1);
    await page.getByTestId('pos-charge').click();
    const due = parseMoney(await page.getByTestId('payment-amount-due').innerText());
    await page.getByTestId('cash-tendered').fill(String(Math.ceil(due)));
    await page.getByTestId('payment-confirm').click();
    await expect(page.getByTestId('receipt-modal')).toBeVisible({ timeout: 20_000 });
    const invoiceId = await page.getByTestId('receipt-modal').getAttribute('data-invoice-id');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const invoice = await json<ApiInvoice>(await request.get(`${API_URL}/billing/invoices/${invoiceId}`), 200);
    expect(invoice.items.map((i) => i.productId)).toEqual([product.id]);
  });
});

/** A photo of the size a phone camera produces, rendered in the page and handed to a file input. */
async function attachPhonePhoto(page: Page, inputTestId: string, width: number, height: number): Promise<number> {
  return page.evaluate(
    async ({ testId, w, h }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const image = ctx.createImageData(w, h);
      // Sensor noise over a paper-white page: what makes a full-resolution phone JPEG large.
      for (let i = 0; i < image.data.length; i += 4) {
        const v = 255 - Math.floor(Math.random() * 55);
        image.data[i] = v;
        image.data[i + 1] = v - Math.floor(Math.random() * 27);
        image.data[i + 2] = v - Math.floor(Math.random() * 27);
        image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      ctx.fillStyle = '#111';
      ctx.font = `${Math.round(h / 40)}px monospace`;
      ['KIRANA STORES', 'Toor Dal 1kg      2  296.00', 'Basmati Rice 5kg  1  640.00'].forEach((text, row) => ctx.fillText(text, w / 10, h / 6 + row * (h / 25)));
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/jpeg', 0.95));
      const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'IMG_20261008_101500.jpg', { type: 'image/jpeg' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return blob.size;
    },
    { testId: inputTestId, w: width, h: height },
  );
}

test.describe('bills photographed with a phone', () => {
  test('the AI scanner sends a 50 MP photo scaled down instead of having it refused', async ({ page }) => {
    await page.goto('/ai-scanner');
    await expect(page.getByTestId('scan-input')).toBeAttached();
    const uploaded = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ocr/scan-bill'), { timeout: 60_000 });
    const original = await attachPhonePhoto(page, 'scan-input', 8160, 6120);
    expect(original).toBeGreaterThan(10 * 1024 * 1024);

    const response = await uploaded;
    expect(Number(await response.request().headerValue('content-length'))).toBeLessThan(2.5 * 1024 * 1024);
    // The test API has no Gemini key: once the photo is within the limit, the honest answer is 503 OCR_NOT_CONFIGURED.
    expect(response.status()).toBe(503);
  });

  test('a 12 MP photo goes up at a size a slow mobile uplink can carry', async ({ page }) => {
    await page.goto('/ai-scanner');
    await expect(page.getByTestId('scan-input')).toBeAttached();
    const uploaded = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/ocr/scan-bill'), { timeout: 60_000 });
    const original = await attachPhonePhoto(page, 'scan-input', 4000, 3000);
    expect(original).toBeGreaterThan(5 * 1024 * 1024);
    // About 140 s at Slow 3G's 50 KB/s for the original, past the scanner's 90 s timeout; under 40 s once scaled.
    expect(Number(await (await uploaded).headerValue('content-length'))).toBeLessThan(2 * 1024 * 1024);
  });

  test('the AI scanner shows the API\'s own reason for a failure that is not about configuration', async ({ page }) => {
    await page.route(/\/api\/ocr\/scan-bill$/, (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ statusCode: 502, error: 'BAD_GATEWAY', code: 'OCR_MODEL_ERROR', message: 'The OCR model rejected the request.', details: { status: 403 } }) }),
    );
    await page.goto('/ai-scanner');
    await expect(page.getByTestId('scan-input')).toBeAttached();
    await attachPhonePhoto(page, 'scan-input', 800, 600);
    const failure = page.getByTestId('scan-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('The OCR model rejected the request.');
    await expect(failure).not.toContainText('not a bill');
  });

  test('Smart Capture stores a 50 MP gallery photo', async ({ page }) => {
    await page.goto('/smart-capture');
    await expect(page.getByTestId('gallery-input')).toBeAttached();
    await attachPhonePhoto(page, 'gallery-input', 8160, 6120);
    const stored = page.waitForResponse((r) => r.request().method() === 'POST' && /\/storage\/bills\//.test(new URL(r.url()).pathname), { timeout: 60_000 });
    await page.getByText('Save Original Photo').click();
    const response = await stored;
    // A refused upload of 30 MB may not keep its body in the inspector: the status is the verdict.
    const status = response.status();
    expect(status, status === 201 ? '' : await response.text().catch(() => '(body not kept)')).toBe(201);
  });
});

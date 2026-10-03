import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Roadmap 6.1: every former mock flow now persists through the API or is gone.
 *
 * Runs against the API + web servers started by playwright.config.ts with the
 * auth bypass on (the bypass user is the OWNER of its own shop). Each test
 * creates its own data through the API and asserts persistence through a
 * fresh page load AND the API, never through the UI's optimistic state.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
/** Where the API started by playwright.config.ts writes documents (apps/api/.env.test: `STORAGE_ROOT=./data/storage`). */
const STORAGE_ROOT = process.env.E2E_STORAGE_ROOT ?? path.resolve(__dirname, '../../api/data/storage');

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function tenDigits(): string {
  return String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
}

interface ApiSupplier {
  id: string;
  name: string;
  phone: string;
  contactPerson: string | null;
  isActive: boolean;
}

async function createSupplier(request: APIRequestContext): Promise<ApiSupplier> {
  // "AAA" keeps the row on the first (name-ordered) page of GET /suppliers.
  const res = await request.post(`${API_URL}/suppliers`, {
    data: { name: unique('AAA E2E Supplier'), phone: tenDigits(), contactPerson: 'Before Edit' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiSupplier;
}

/** A real JPEG rendered by the browser (the API sniffs the bytes, so a stub would be rejected). */
async function renderJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111111';
    ctx.font = '24px sans-serif';
    ctx.fillText('Bill 2 x Chai 20.00', 16, 60);
    return canvas.toDataURL('image/jpeg', 0.9);
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** The Modal component has no dialog role: scope on the panel that carries the title. */
function modal(page: Page, title: string | RegExp) {
  return page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: title }) });
}

async function findSupplier(request: APIRequestContext, id: string): Promise<ApiSupplier | undefined> {
  const res = await request.get(`${API_URL}/suppliers?take=200`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as ApiSupplier[]).find((s) => s.id === id);
}

/** The stored bill files of `customerId`, across shops (the bypass shop id is not known to the test). */
function storedBillFiles(customerId: string, billId: string): string[] {
  if (!fs.existsSync(STORAGE_ROOT)) return [];
  return fs
    .readdirSync(STORAGE_ROOT)
    .map((shopId) => path.join(STORAGE_ROOT, shopId, 'Customers', customerId, 'Bills'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.startsWith(`BILL-${billId}.`)).map((f) => path.join(dir, f)));
}

function billIdFrom(banner: string): string {
  const match = /BILL-([A-Za-z0-9-]+)/.exec(banner);
  if (!match) throw new Error(`No bill id in "${banner}"`);
  return match[1];
}

async function openSupplierActions(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder('Search by supplier name, contact, or phone...').fill(name);
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
}

test.describe('suppliers page persists through the API', () => {
  test('editing a supplier survives a reload', async ({ page, request }) => {
    const supplier = await createSupplier(request);
    const newName = unique('AAA E2E Edited');
    const newPhone = tenDigits();

    await page.goto('/suppliers');
    await openSupplierActions(page, supplier.name);
    await page.getByRole('button', { name: 'Edit Supplier', exact: true }).click();

    const dialog = modal(page, `Edit Supplier: ${supplier.name}`);
    await expect(dialog).toBeVisible();
    // Field order in the form: name, contact person, phone, email, GSTIN, address.
    await dialog.locator('input').nth(0).fill(newName);
    await dialog.locator('input').nth(1).fill('After Edit');
    await dialog.locator('input').nth(2).fill(newPhone);

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/suppliers/${supplier.id}`));
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByText(`${newName} updated`)).toBeVisible();

    await page.reload();
    await page.getByPlaceholder('Search by supplier name, contact, or phone...').fill(newName);
    await expect(page.getByRole('cell', { name: newName, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: supplier.name, exact: true })).toHaveCount(0);

    const stored = await findSupplier(request, supplier.id);
    expect(stored).toMatchObject({ name: newName, phone: newPhone, contactPerson: 'After Edit' });
  });

  test('deleting a supplier removes it on the server', async ({ page, request }) => {
    const supplier = await createSupplier(request);

    await page.goto('/suppliers');
    await openSupplierActions(page, supplier.name);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    const dialog = modal(page, 'Delete Supplier');
    await expect(dialog).toBeVisible();
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/suppliers/${supplier.id}`));
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await del).status()).toBe(200);
    await expect(page.getByRole('cell', { name: supplier.name, exact: true })).toHaveCount(0);

    await page.reload();
    await page.getByPlaceholder('Search by supplier name, contact, or phone...').fill(supplier.name);
    await expect(page.getByText('No suppliers found')).toBeVisible();
    expect(await findSupplier(request, supplier.id)).toBeUndefined();
  });

  test('a supplier payment is recorded with the chosen tender', async ({ page, request }) => {
    const res = await request.post(`${API_URL}/suppliers`, {
      data: { name: unique('AAA E2E Payable'), phone: tenDigits(), openingBalance: 500 },
    });
    expect(res.status(), await res.text()).toBe(201);
    const supplier = (await res.json()) as ApiSupplier;

    await page.goto('/suppliers');
    await openSupplierActions(page, supplier.name);
    await page.getByRole('button', { name: 'Pay Supplier', exact: true }).click();
    const dialog = modal(page, `Pay Supplier: ${supplier.name}`);
    await dialog.getByPlaceholder('0').fill('120');
    await dialog.locator('select').selectOption('UPI');

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/suppliers/${supplier.id}/payments`));
    await dialog.getByRole('button', { name: 'Confirm Payment' }).click();
    const response = await post;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ amount: 120, tender: 'UPI' });

    await expect(page.getByText(`₹120 paid to ${supplier.name}`)).toBeVisible();
    const stored = (await findSupplier(request, supplier.id)) as unknown as { pendingPayables: number };
    expect(Number(stored.pendingPayables)).toBe(380);
  });
});

test.describe('employees page uses real accounts', () => {
  test('lists the shop users and issues a real invitation', async ({ page, request }) => {
    const employees = (await (await request.get(`${API_URL}/users/employees`)).json()) as Array<{ id: string; name: string }>;
    expect(employees.length).toBeGreaterThan(0);

    await page.goto('/employees');
    for (const employee of employees.slice(0, 3)) {
      await expect(page.getByTestId(`employee-row-${employee.id}`)).toBeVisible();
    }
    // The mock-up columns are gone.
    await expect(page.getByRole('columnheader', { name: /salary|attendance|shift/i })).toHaveCount(0);

    const email = `e2e-${Date.now().toString(36)}@example.com`;
    await page.getByRole('button', { name: 'Invite Employee' }).click();
    const dialog = modal(page, 'Invite a Staff Member');
    await dialog.getByPlaceholder('e.g. raju@example.com').fill(email);
    await dialog.locator('select').selectOption('CASHIER');

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/invitations/generate'));
    await dialog.getByRole('button', { name: 'Send Invitation' }).click();
    const response = await post;
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { invitationId: string; email: string; role: string };
    expect(body).toMatchObject({ email, role: 'CASHIER' });
    // The code reaches the invitee by email only: the browser never sees it.
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    await expect(page.getByText(`Invitation emailed to ${email}`, { exact: false })).toBeVisible();

    const revoke = await request.delete(`${API_URL}/invitations/${body.invitationId}/revoke`);
    expect(revoke.status()).toBe(200);
  });

  test('the register page joins a shop from an invitation link', async ({ page }) => {
    const token = 'a'.repeat(64);
    await page.goto(`/register?invite=${token}`);
    await expect(page.getByRole('heading', { name: 'Join your shop' })).toBeVisible();
    await expect(page.getByPlaceholder('Kumar General Store')).toHaveCount(0);

    await page.getByPlaceholder('Rajesh Kumar').fill('Invited Cashier');
    await page.getByPlaceholder('Min. 8 characters').fill('Str0ngPassword!');
    const accept = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/invitations/accept'));
    await page.getByRole('button', { name: 'Join Shop' }).click();
    expect((await accept).status()).toBe(404);
    await expect(page.getByText('This invitation code is invalid or has expired', { exact: false })).toBeVisible();
  });
});

test.describe('smart capture stores the bill', () => {
  test('a gallery photo is uploaded to /storage/bills as a photo and as a PDF', async ({ page, request }) => {
    const customerRes = await request.post(`${API_URL}/customers`, {
      data: { name: unique('E2E Capture Customer'), phone: tenDigits() },
    });
    expect(customerRes.status(), await customerRes.text()).toBe(201);
    const customer = (await customerRes.json()) as { id: string; name: string };

    await page.goto('/smart-capture');
    const jpeg = await renderJpeg(page);

    // 1. Walk-in, photo only.
    await page.getByTestId('gallery-input').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    const photoPost = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.includes('/storage/bills/Walk-in/'));
    await page.getByRole('button', { name: 'Save Original Photo' }).click();
    const photoResponse = await photoPost;
    expect(photoResponse.status(), await photoResponse.text()).toBe(201);
    expect(photoResponse.request().headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const banner = page.getByTestId('capture-success');
    await expect(banner).toContainText('Original photo stored under Walk-in / General › Bills › BILL-');
    // Persisted on the API's disk: the JPEG and nothing else.
    const photoFiles = storedBillFiles('Walk-in', billIdFrom((await banner.textContent()) ?? ''));
    expect(photoFiles.map((f) => path.extname(f)).sort()).toEqual(['.jpg']);
    expect(fs.readFileSync(photoFiles[0]).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // 2. Named customer, photo + client-side PDF.
    await page.locator('select').first().selectOption(customer.id);
    await page.getByTestId('gallery-input').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    const pdfPost = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.includes(`/storage/bills/${customer.id}/`));
    await page.getByRole('button', { name: 'Convert to PDF' }).click();
    const pdfResponse = await pdfPost;
    expect(pdfResponse.status(), await pdfResponse.text()).toBe(201);
    await expect(banner).toContainText(`Original photo and PDF stored under ${customer.name} › Bills › BILL-`);
    const pdfFiles = storedBillFiles(customer.id, billIdFrom((await banner.textContent()) ?? ''));
    expect(pdfFiles.map((f) => path.extname(f)).sort()).toEqual(['.jpg', '.pdf']);
    const pdf = fs.readFileSync(pdfFiles.find((f) => f.endsWith('.pdf'))!).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Filter /DCTDecode');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

test.describe('AI scanner calls the OCR route', () => {
  test('an upload reaches /ocr/scan-bill and a failure is shown, never a fake result', async ({ page }) => {
    await page.goto('/ai-scanner');
    const jpeg = await renderJpeg(page);
    await page.locator('select').selectOption('RECEIPT');

    const scan = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ocr/scan-bill'));
    await page.getByTestId('scan-input').setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    const response = await scan;
    // Chromium does not expose blob multipart bodies to Playwright; the API's
    // answer proves the file arrived: a missing part is 400, not 503.
    expect(response.request().headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/);

    if (response.status() === 201) {
      // A configured Gemini key: the page renders the API's answer.
      await expect(page.getByTestId('scan-result')).toBeVisible();
      await expect(page.getByTestId('scan-failure')).toHaveCount(0);
      return;
    }
    // CI / test: GEMINI_API_KEY is a placeholder, so the API answers 503.
    expect(response.status()).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'OCR_NOT_CONFIGURED' });
    await expect(page.getByTestId('scan-failure')).toContainText('OCR is not configured on this server');
    await expect(page.getByTestId('scan-result')).toHaveCount(0);
    await expect(page.getByText(/extracted|synced|updated inventory/i)).toHaveCount(0);
  });

  test('a PDF is refused before any request is made', async ({ page }) => {
    await page.goto('/ai-scanner');
    let requests = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('/ocr/scan-bill')) requests += 1;
    });
    await page.getByTestId('scan-input').setInputFiles({ name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByText('Upload a JPEG, PNG or WebP photo of the bill', { exact: false })).toBeVisible();
    expect(requests).toBe(0);
  });
});

test.describe('stub pages are gone', () => {
  for (const path of ['/ai-assistant', '/database']) {
    test(`${path} answers 404 and is not linked from the sidebar`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);

      await page.goto('/dashboard');
      await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
      await expect(page.getByText('Database Manager')).toHaveCount(0);
    });
  }
});

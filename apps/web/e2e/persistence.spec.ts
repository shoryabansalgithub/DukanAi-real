import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Phase 6 exit gate, second half: every mutating UI action that was real before
 * phase 6 (so no 6.x row "repaired" it) is asserted here the same way as the
 * repaired ones in fake-flows.spec.ts: after a fresh page load AND against the
 * API, never through the UI's optimistic state. Invoice cancel and return,
 * customers (create, payment, delete from the list and the detail page, the POS
 * picker), shifts, employees, expenses, notifications (page and navbar),
 * suppliers and stock adjustments.
 *
 * Runs against the servers started by playwright.config.ts (auth bypass on: the
 * bypass user is the OWNER of its own shop). Every test creates its own data.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'mysql://root:password@localhost:3306/dukaanai_test';
const PRODUCTS_PATH = `${new URL(API_URL).pathname}/products`;

// bcrypt is the API's hashing library (hoisted to the workspace root); the employee row is inserted directly.
const require = createRequire(__filename);
const bcrypt = require('bcrypt') as { hash(data: string, rounds: number): Promise<string> };

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function tenDigits(): string {
  return String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
}

/** The Modal component has no dialog role: scope on the panel that carries the title. */
function modal(page: Page, title: string | RegExp) {
  return page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: title }) });
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, expected = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(expected);
  return (await res.json()) as T;
}

interface ApiProduct {
  id: string;
  name: string;
  sku: string;
}

/** A ZERO-rated ₹100 product: every total below is an exact multiple of 100, so no engine call is needed to pay it. */
async function createProduct(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<ApiProduct> {
  const name = unique('Persist item');
  const res = await request.post(`${API_URL}/products`, {
    data: { name, type: 'SERVICE', unit: 'PCS', gstRate: 'ZERO', costPrice: 40, sellingPrice: 100, mrp: 100, wholesalePrice: 100, ...overrides },
  });
  const body = await json<{ id: string; sku: string }>(res, 201);
  return { id: body.id, name, sku: body.sku };
}

interface ApiCustomer {
  id: string;
  name: string;
  phone: string;
}

async function createCustomer(request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<ApiCustomer> {
  const name = unique('Persist customer');
  const phone = tenDigits();
  const res = await request.post(`${API_URL}/customers`, { data: { name, phone, ...extra } });
  const body = await json<{ id: string }>(res, 201);
  return { id: body.id, name, phone };
}

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  type: string;
  status: string;
  totalAmount: string | number;
  udharAmount: string | number;
  items: Array<{ id: string; productName: string; quantity: string | number; returnedQuantity: string | number }>;
  returns: Array<{ id: string; invoiceNumber: string }>;
}

/** A cash sale, or a credit (udhar) sale when `customerId` is given with `onCredit`. */
async function createSale(
  request: APIRequestContext,
  product: ApiProduct,
  quantity: number,
  options: { customerId?: string; onCredit?: boolean } = {},
): Promise<ApiInvoice> {
  const total = 100 * quantity;
  const res = await request.post(`${API_URL}/billing/invoice`, {
    data: {
      idempotencyKey: randomUUID(),
      items: [{ productId: product.id, quantity }],
      customerId: options.customerId,
      payments: options.onCredit ? [] : [{ tender: 'CASH', amount: total }],
      udharAmount: options.onCredit ? total : 0,
    },
  });
  const body = await json<{ invoice: ApiInvoice }>(res, 201);
  return body.invoice;
}

async function fetchInvoice(request: APIRequestContext, id: string): Promise<ApiInvoice> {
  return json<ApiInvoice>(await request.get(`${API_URL}/billing/invoices/${id}`));
}

async function searchProducts(page: Page, term: string): Promise<void> {
  // The footer is rendered from the first list fetch (an effect), which proves the page is hydrated before typing.
  await expect(page.getByTestId('products-pagination')).toBeVisible();
  const listed = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === PRODUCTS_PATH && new URL(r.url()).searchParams.get('q') === term);
  await page.getByPlaceholder('Search by product name or SKU...').fill(term);
  expect((await listed).status()).toBe(200);
}

const isPath = (suffix: string) => (r: { url(): string }) => new URL(r.url()).pathname.endsWith(suffix);

/** `GET /shifts/current` answers an empty body when the actor has no open shift. */
async function hasOpenShift(request: APIRequestContext): Promise<boolean> {
  return (await (await request.get(`${API_URL}/shifts/current`)).text()).trim().startsWith('{');
}

/** Cancelling or refunding cash needs the actor's shift (SHIFT_REQUIRED otherwise). */
async function ensureOpenShift(request: APIRequestContext): Promise<void> {
  if (await hasOpenShift(request)) return;
  await json(await request.post(`${API_URL}/shifts/open`, { data: { openingCash: 0 } }), 201);
}

test.describe('invoice detail (cancel and return)', () => {
  test('cancelling an invoice marks it cancelled on the server and after a reload', async ({ page, request }) => {
    await ensureOpenShift(request);
    const product = await createProduct(request);
    const invoice = await createSale(request, product, 2);

    await page.goto(`/invoices/${invoice.id}`);
    await expect(page.getByRole('heading', { name: invoice.invoiceNumber })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Cancel ${invoice.invoiceNumber}?` })).toBeVisible();
    await page.getByLabel('Cancellation reason').fill('Billed to the wrong customer');
    const cancel = page.waitForResponse((r) => r.request().method() === 'POST' && isPath(`/billing/invoices/${invoice.id}/cancel`)(r));
    await page.getByRole('button', { name: 'Cancel invoice' }).click();
    expect((await cancel).status(), await (await cancel).text()).toBe(200);
    await expect(page.getByText(`Invoice ${invoice.invoiceNumber} cancelled`)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Cancelled' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    const stored = await fetchInvoice(request, invoice.id);
    expect(stored.status).toBe('CANCELLED');
  });

  test('a partial return creates the return document and is recorded against the sale', async ({ page, request }) => {
    await ensureOpenShift(request);
    const product = await createProduct(request);
    const invoice = await createSale(request, product, 3);

    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole('button', { name: 'Return', exact: true }).click();
    const dialog = modal(page, `Return items · ${invoice.invoiceNumber}`);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(`Return quantity for ${product.name}`).fill('1');
    const submit = dialog.getByRole('button', { name: /^Return 1 item/ });
    await expect(submit).toBeEnabled();
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/billing/returns')(r));
    await submit.click();
    const created = (await json<{ invoice: { id: string; invoiceNumber: string } }>(await posted, 201)).invoice;
    expect(created.id).not.toBe(invoice.id);
    await page.waitForURL(`**/invoices/${created.id}`);
    await expect(page.getByRole('heading', { name: created.invoiceNumber })).toBeVisible();

    await page.reload();
    await expect(page.getByText('Returned against', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: invoice.invoiceNumber })).toBeVisible();
    const original = await fetchInvoice(request, invoice.id);
    expect(original.returns.map((r) => r.id)).toEqual([created.id]);
    expect(Number(original.items[0].returnedQuantity)).toBe(1);
    const returned = await fetchInvoice(request, created.id);
    expect(returned.type).toBe('SALES_RETURN');
    expect(Number(returned.totalAmount)).toBe(100);
  });
});

test.describe('customers', () => {
  test('adding a customer persists; deleting from the list asks first and removes it on the server', async ({ page, request }) => {
    const name = unique('Added customer');
    const phone = tenDigits();
    await page.goto('/customers');
    await page.getByRole('button', { name: 'Add customer' }).click();
    const dialog = modal(page, 'Add new customer');
    await expect(dialog).toBeVisible();
    await dialog.locator('#customer-name').fill(name);
    await dialog.locator('#customer-phone').fill(phone);
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/customers')(r));
    await dialog.getByRole('button', { name: 'Save customer' }).click();
    const created = await json<{ id: string }>(await post, 201);
    await expect(page.getByText('Customer added')).toBeVisible();

    await page.reload();
    await page.getByLabel('Search customers').fill(phone);
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    const listed = await json<{ items: Array<{ id: string; name: string }> }>(await request.get(`${API_URL}/customers?q=${phone}`));
    expect(listed.items.map((c) => c.id)).toContain(created.id);

    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { name: `Delete ${name}?` })).toBeVisible();
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && isPath(`/customers/${created.id}`)(r));
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect([200, 204]).toContain((await del).status());
    await expect(page.getByText(`${name} deleted`)).toBeVisible();

    await page.reload();
    await page.getByLabel('Search customers').fill(phone);
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
    expect((await request.get(`${API_URL}/customers/${created.id}`)).status()).toBe(404);
  });

  test('a recorded payment reduces the outstanding balance; the detail page delete removes the customer', async ({ page, request }) => {
    const product = await createProduct(request);
    const customer = await createCustomer(request, { creditLimit: 100000 });
    await createSale(request, product, 2, { customerId: customer.id, onCredit: true });

    await page.goto(`/customers/${customer.id}`);
    // The innermost block that holds the "Outstanding" label also holds its figure (Total purchases shows the same ₹200).
    const outstanding = page.locator('div', { has: page.getByText('Outstanding', { exact: true }) }).last();
    await expect(outstanding.getByRole('heading')).toHaveText('₹200');
    await page.getByRole('button', { name: 'Record payment' }).click();
    const dialog = modal(page, `Record payment — ${customer.name}`);
    await expect(dialog).toBeVisible();
    await dialog.locator('#payment-amount').fill('150');
    const paid = page.waitForResponse((r) => r.request().method() === 'POST' && isPath(`/customers/${customer.id}/payments`)(r));
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    expect((await paid).status(), await (await paid).text()).toBe(201);
    await expect(page.getByText(`₹150 received from ${customer.name}`)).toBeVisible();

    await page.reload();
    await expect(outstanding.getByRole('heading')).toHaveText('₹50');
    const stored = await json<{ outstandingBalance: string | number }>(await request.get(`${API_URL}/customers/${customer.id}`));
    expect(Number(stored.outstandingBalance)).toBe(50);
    const ledger = await json<{ items: Array<{ type: string; amount: string | number }> }>(await request.get(`${API_URL}/customers/${customer.id}/ledger`));
    expect(ledger.items.some((row) => row.type === 'PAYMENT' && Number(row.amount) === 150)).toBe(true);

    // The remainder is settled through the API so the delete is allowed (409 CUSTOMER_HAS_BALANCE otherwise).
    expect((await request.post(`${API_URL}/customers/${customer.id}/payments`, { data: { idempotencyKey: randomUUID(), amount: 50, tender: 'CASH' } })).status()).toBe(201);
    await page.reload();
    await page.getByRole('button', { name: 'Delete customer' }).click();
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && isPath(`/customers/${customer.id}`)(r));
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect([200, 204]).toContain((await del).status());
    await page.waitForURL('**/customers');
    expect((await request.get(`${API_URL}/customers/${customer.id}`)).status()).toBe(404);
  });

  test('the POS picker creates a real customer and selects it', async ({ page, request }) => {
    const name = unique('POS customer');
    const phone = tenDigits();
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
    await page.getByRole('button', { name: 'Add new customer' }).click();
    await page.getByLabel('Customer name').fill(name);
    await page.getByLabel('Customer phone').fill(phone);
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/customers')(r));
    await page.getByRole('button', { name: 'Save & select' }).click();
    const created = await json<{ id: string }>(await post, 201);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove customer (walk-in)' })).toBeVisible();

    const found = await json<Array<{ id: string; name: string }>>(await request.post(`${API_URL}/customers/search`, { data: { query: phone, take: 5 } }));
    expect(found.map((c) => c.id)).toContain(created.id);
    const stored = await json<{ name: string; phone: string }>(await request.get(`${API_URL}/customers/${created.id}`));
    expect(stored).toMatchObject({ name, phone });
  });
});

test.describe('shifts', () => {
  test('opening and closing a shift from the banner persists on the server', async ({ page, request }) => {
    // A shift left open by an aborted run would make "Open shift" answer SHIFT_ALREADY_OPEN.
    if (await hasOpenShift(request)) {
      expect([200, 201]).toContain((await request.post(`${API_URL}/shifts/current/close`, { data: { closingCash: 0 } })).status());
    }

    await page.goto('/billing');
    await expect(page.getByText('No open shift')).toBeVisible();
    await page.getByRole('button', { name: 'Open shift' }).click();
    const open = modal(page, 'Open shift');
    await expect(open).toBeVisible();
    await open.locator('#opening-cash').fill('500');
    const opened = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/shifts/open')(r));
    await open.getByRole('button', { name: 'Open shift' }).click();
    expect((await opened).status(), await (await opened).text()).toBe(201);
    await expect(page.getByText('Shift opened')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Shift open', { exact: true })).toBeVisible();
    const shift = await json<{ status: string; openingCash: string | number }>(await request.get(`${API_URL}/shifts/current`));
    expect(shift.status).toBe('OPEN');
    expect(Number(shift.openingCash)).toBe(500);

    await page.getByRole('button', { name: 'Close shift' }).click();
    const close = modal(page, 'Close shift');
    await expect(close).toBeVisible();
    await close.locator('#closing-cash').fill('500');
    const closed = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/shifts/current/close')(r));
    await close.getByRole('button', { name: 'Close shift' }).click();
    expect((await closed).status(), await (await closed).text()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Shift closed' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    await page.reload();
    await expect(page.getByText('No open shift')).toBeVisible();
    expect(await hasOpenShift(request)).toBe(false);
  });
});

test.describe('employees', () => {
  test('suspend, reinstate and remove persist on the server', async ({ page, request }) => {
    const shop = await json<{ id: string }>(await request.get(`${API_URL}/shops/me`));
    const id = `emp-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const name = unique('E2E Cashier');
    const conn = await mysql.createConnection(DATABASE_URL);
    try {
      await conn.execute(
        'INSERT INTO User (id, email, password, name, role, shopId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))',
        [id, `${id}@example.com`, await bcrypt.hash('Str0ng-Passw0rd!', 4), name, 'CASHIER', shop.id],
      );
    } finally {
      await conn.end();
    }
    const employee = async () => (await json<Array<{ id: string; isActive: boolean }>>(await request.get(`${API_URL}/users/employees`))).find((u) => u.id === id);

    await page.goto('/employees');
    const search = page.getByPlaceholder('Search by name, email or phone...');
    await search.fill(name);
    const row = page.getByTestId(`employee-row-${id}`);
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    const suspended = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath(`/users/${id}/suspend`)(r));
    await page.getByRole('button', { name: 'Suspend Access' }).click();
    expect((await suspended).status()).toBe(200);
    await expect(page.getByText(`${name} suspended`, { exact: false })).toBeVisible();

    await page.reload();
    await search.fill(name);
    await expect(row).toContainText('Suspended');
    expect((await employee())?.isActive).toBe(false);

    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    const reinstated = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath(`/users/${id}/suspend`)(r));
    await page.getByRole('button', { name: 'Reinstate Access' }).click();
    expect((await reinstated).status()).toBe(200);
    await expect(page.getByText(`${name} reinstated`)).toBeVisible();
    expect((await employee())?.isActive).toBe(true);

    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('button', { name: 'Remove from Shop' }).click();
    const dialog = modal(page, 'Remove from Shop');
    await expect(dialog).toBeVisible();
    const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && isPath(`/users/${id}`)(r));
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByText(`${name} removed from the shop`)).toBeVisible();

    await page.reload();
    await search.fill(name);
    await expect(row).toHaveCount(0);
    expect(await employee()).toBeUndefined();
  });
});

test.describe('expenses', () => {
  test('recording, marking as paid and deleting an expense persist on the server', async ({ page, request }) => {
    const description = unique('Recorded expense');
    const find = async () => (await json<Array<{ id: string; description: string; status: 'Paid' | 'Pending' }>>(await request.get(`${API_URL}/expenses?take=100`))).find((e) => e.description === description);

    await page.goto('/expenses');
    await page.getByRole('button', { name: 'Record Expense' }).click();
    const dialog = modal(page, 'Record New Expense');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').nth(0).fill(description);
    await dialog.locator('input').nth(1).fill('321');
    await dialog.locator('select').first().selectOption('Supplies');
    await dialog.getByRole('button', { name: 'Pending', exact: true }).click();
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/expenses')(r));
    await dialog.locator('button[type="submit"]').click();
    expect((await post).status(), await (await post).text()).toBe(201);
    await expect(page.getByText('₹321 recorded under Supplies')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: `Actions for ${description}` })).toBeVisible();
    expect(await find()).toMatchObject({ status: 'Pending', amount: 321, category: 'Supplies' });

    await page.getByRole('button', { name: `Actions for ${description}` }).click();
    const paid = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.includes('/expenses/'));
    await page.getByRole('button', { name: 'Mark as Paid' }).click();
    expect((await paid).status()).toBe(200);
    await expect(page.getByText(`"${description}" marked as Paid`)).toBeVisible();
    await page.reload();
    expect(await find()).toMatchObject({ status: 'Paid' });

    await page.getByRole('button', { name: `Actions for ${description}` }).click();
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.includes('/expenses/'));
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect([200, 204]).toContain((await del).status());
    await expect(page.getByText(`Expense "${description}" deleted`)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: `Actions for ${description}` })).toHaveCount(0);
    expect(await find()).toBeUndefined();
  });
});

test.describe('notifications', () => {
  async function createNotification(request: APIRequestContext, title: string): Promise<{ id: string }> {
    return json<{ id: string }>(await request.post(`${API_URL}/notifications`, { data: { type: 'LOW_STOCK', title, message: `${title} message` } }), 201);
  }
  async function readState(request: APIRequestContext, ids: string[]): Promise<boolean[]> {
    const list = await json<Array<{ id: string; isRead: boolean }>>(await request.get(`${API_URL}/notifications`));
    return ids.map((id) => list.find((n) => n.id === id)?.isRead ?? false);
  }

  test('the page marks one and then all notifications read on the server', async ({ page, request }) => {
    const a = unique('Notice A');
    const b = unique('Notice B');
    const [na, nb] = [await createNotification(request, a), await createNotification(request, b)];

    await page.goto('/notifications');
    const read = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath(`/notifications/${na.id}/read`)(r));
    await page.getByRole('heading', { name: a }).click();
    expect((await read).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: b })).toBeVisible();
    expect(await readState(request, [na.id, nb.id])).toEqual([true, false]);

    const all = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath('/notifications/read-all')(r));
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    expect((await all).status()).toBe(200);
    await expect(page.getByText('All notifications marked as read')).toBeVisible();
    expect(await readState(request, [na.id, nb.id])).toEqual([true, true]);
  });

  test('the navbar bell marks one and then all notifications read on the server', async ({ page, request }) => {
    const c = unique('Notice C');
    const d = unique('Notice D');
    const [nc, nd] = [await createNotification(request, c), await createNotification(request, d)];

    await page.goto('/dashboard');
    const bell = page.getByRole('button', { name: /^Notifications/ });
    await expect(bell).toHaveAttribute('aria-label', /unread$/);
    await bell.click();
    const read = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath(`/notifications/${nc.id}/read`)(r));
    await page.getByRole('menuitem', { name: c }).click();
    expect((await read).status()).toBe(200);
    expect(await readState(request, [nc.id, nd.id])).toEqual([true, false]);

    await bell.click();
    const all = page.waitForResponse((r) => r.request().method() === 'PATCH' && isPath('/notifications/read-all')(r));
    await page.getByRole('button', { name: 'Mark all read' }).click();
    expect((await all).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    expect(await readState(request, [nc.id, nd.id])).toEqual([true, true]);
  });
});

test.describe('suppliers', () => {
  test('adding a supplier persists on the server', async ({ page, request }) => {
    // "AAA" keeps the row on the first (name-ordered) page of GET /suppliers.
    const name = unique('AAA Added supplier');
    const phone = tenDigits();
    await page.goto('/suppliers');
    await page.getByRole('button', { name: 'Add Supplier' }).click();
    const dialog = modal(page, 'Add New Supplier');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').nth(0).fill(name);
    await dialog.locator('input').nth(1).fill('Added Contact');
    await dialog.locator('input').nth(2).fill(phone);
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && isPath('/suppliers')(r));
    await dialog.getByRole('button', { name: 'Save Supplier' }).click();
    const created = await json<{ id: string }>(await post, 201);
    await expect(page.getByText('Supplier added successfully')).toBeVisible();

    await page.reload();
    await page.getByPlaceholder('Search by supplier name, contact, or phone...').fill(name);
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    const listed = await json<Array<{ id: string; name: string; phone: string; contactPerson: string | null }>>(await request.get(`${API_URL}/suppliers?take=200`));
    expect(listed.find((s) => s.id === created.id)).toMatchObject({ name, phone, contactPerson: 'Added Contact' });
  });
});

test.describe('products stock', () => {
  test('Update Stock records an adjustment the API reflects', async ({ page, request }) => {
    const product = await createProduct(request, { type: 'SIMPLE' });
    await page.goto('/products');
    await searchProducts(page, product.name);
    await expect(page.getByTestId(`product-row-${product.id}`)).toBeVisible();
    await page.getByRole('button', { name: `Actions for ${product.name}` }).click();
    await page.getByRole('button', { name: 'Update Stock', exact: true }).click();
    const dialog = modal(page, `Adjust Stock: ${product.name}`);
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill('5');
    await dialog.locator('select').first().selectOption('MANUAL_COUNT');
    const adjusted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/inventory-domain\/[^/]+\/adjust$/.test(new URL(r.url()).pathname));
    await dialog.locator('button[type="submit"]').click();
    expect((await adjusted).status(), await (await adjusted).text()).toBe(201);
    await expect(page.getByText('Stock updated successfully.')).toBeVisible();

    await page.reload();
    await searchProducts(page, product.name);
    await expect(page.getByTestId(`product-row-${product.id}`)).toContainText('5');
    const stored = await json<{ currentStock: string | number }>(await request.get(`${API_URL}/products/${product.id}`));
    expect(Number(stored.currentStock)).toBe(5);
  });
});

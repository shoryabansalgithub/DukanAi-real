import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Roadmap 6.2 / 6.3: the products page is a real server page (paging, `q`,
 * stats from the API, edit, delete with confirmation, GST and unit fields,
 * no invented cost price, SKU numbered by the server) and the settings page
 * persists the fields that decide IGST. Every mutation is asserted after a
 * reload AND against the API, never through optimistic UI state.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const PRODUCTS_PATH = `${new URL(API_URL).pathname}/products`;

/** The products list request itself (not `/dashboard/products` or `/inventory/products`). */
function isProductList(url: string): boolean {
  return new URL(url).pathname === PRODUCTS_PATH;
}

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

interface ApiProduct {
  id: string;
  name: string;
  sku: string;
  costPrice: string | number;
  sellingPrice: string | number;
  mrp: string | number;
  gstRate: string;
  unit: string;
}

/** The Modal component has no dialog role: scope on the panel that carries the title. */
function modal(page: Page, title: string | RegExp) {
  return page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: title }) });
}

async function createProduct(request: APIRequestContext, name: string, extra: Record<string, unknown> = {}): Promise<ApiProduct> {
  const res = await request.post(`${API_URL}/products`, {
    data: { name, costPrice: 40, sellingPrice: 100, mrp: 100, wholesalePrice: 100, unit: 'PCS', gstRate: 'FIVE', ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiProduct;
}

async function searchProducts(page: Page, term: string): Promise<void> {
  // The footer is rendered from the first list fetch, which runs in an effect: it proves the page is hydrated,
  // so the keystrokes below reach React (a fill before hydration on the dev server is lost, no request follows).
  await expect(page.getByTestId('products-pagination')).toBeVisible();
  const listed = page.waitForResponse((r) => r.request().method() === 'GET' && isProductList(r.url()) && new URL(r.url()).searchParams.get('q') === term);
  await page.getByPlaceholder('Search by product name or SKU...').fill(term);
  expect((await listed).status()).toBe(200);
}

async function openProductActions(page: Page, product: { id: string; name: string }): Promise<void> {
  await expect(page.getByTestId(`product-row-${product.id}`)).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${product.name}` }).click();
}

test.describe('products page (6.2)', () => {
  test('the list is a server page: q goes to the API and the footer shows the API total', async ({ page, request }) => {
    const product = await createProduct(request, unique('Paged item'));
    const head = await request.get(`${API_URL}/products?limit=1`);
    expect(head.status()).toBe(200);
    const total = Number(head.headers()['x-total-count']);
    expect(Number.isFinite(total)).toBe(true);

    const firstLoad = page.waitForResponse((r) => r.request().method() === 'GET' && isProductList(r.url()));
    await page.goto('/products');
    const firstUrl = new URL((await firstLoad).url());
    expect(firstUrl.searchParams.get('limit')).toBe('50');
    expect(firstUrl.searchParams.get('offset')).toBe('0');
    await expect(page.getByTestId('products-total')).toHaveText(String(total));
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
    if (total > 50) {
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      const secondPage = page.waitForResponse((r) => isProductList(r.url()) && new URL(r.url()).searchParams.get('offset') === '50');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      expect((await secondPage).status()).toBe(200);
      await expect(page.getByText('Page 2 of', { exact: false })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    }

    await searchProducts(page, product.name);
    await expect(page.getByTestId(`product-row-${product.id}`)).toBeVisible();
    await expect(page.getByTestId('products-total')).toHaveText('1');

    // The stock filter is applied by the API, not by trimming the loaded page.
    await page.getByRole('button', { name: 'Filters' }).click();
    const filtered = page.waitForResponse((r) => isProductList(r.url()) && new URL(r.url()).searchParams.get('stock') === 'out');
    await page.getByRole('button', { name: 'Out of Stock', exact: true }).click();
    expect((await filtered).status()).toBe(200);
    await expect(page.getByTestId(`product-row-${product.id}`)).toBeVisible(); // a fresh product has no stock
  });

  test('the stats tiles show the API figures', async ({ page, request }) => {
    await page.goto('/products');
    const summary = await request.get(`${API_URL}/dashboard/summary`);
    expect(summary.status()).toBe(200);
    const body = (await summary.json()) as { totalProducts: number | null; lowStockCount: number | null; outOfStockCount: number | null };
    const expectTile = async (testId: string, value: number | null) => {
      await expect(page.getByTestId(testId).getByRole('heading')).toHaveText(value === null ? '—' : String(value));
    };
    await expectTile('stat-total-products', body.totalProducts);
    await expectTile('stat-low-stock', body.lowStockCount);
    await expectTile('stat-out-of-stock', body.outOfStockCount);
  });

  test('adding a product sends the typed cost, GST and unit, and the server numbers the SKU', async ({ page, request }) => {
    const name = unique('Added item');
    await page.goto('/products');
    await page.getByRole('button', { name: 'Add Product' }).click();
    const dialog = modal(page, 'Add New Product');
    await expect(dialog).toBeVisible();
    // Field order: name, SKU (left blank), category, selling price, cost price, initial stock, MRP.
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill(name);
    await inputs.nth(2).fill('E2E Category');
    await inputs.nth(3).fill('150');
    await inputs.nth(4).fill('90');
    await inputs.nth(5).fill('7');
    await dialog.getByLabel('GST Rate').selectOption('TWELVE');
    await dialog.getByLabel('Unit').selectOption('KG');

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && isProductList(r.url()));
    await dialog.getByRole('button', { name: 'Save Product' }).click();
    const response = await post;
    expect(response.status(), await response.text()).toBe(201);
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    expect(sent).toMatchObject({ name, sellingPrice: 150, costPrice: 90, mrp: 150, gstRate: 'TWELVE', unit: 'KG' });
    expect(sent).not.toHaveProperty('sku');
    const created = (await response.json()) as ApiProduct;
    expect(created.sku).toMatch(/^SKU-\d{6}$/);
    await expect(page.getByText(`${name} added (SKU ${created.sku})`)).toBeVisible();

    await page.reload();
    await searchProducts(page, name);
    const row = page.getByTestId(`product-row-${created.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(created.sku);
    await expect(row).toContainText('E2E Category');
    const stored = (await (await request.get(`${API_URL}/products/${created.id}`)).json()) as ApiProduct & { currentStock: string | number };
    expect(Number(stored.currentStock)).toBe(7);
    expect(Number(stored.costPrice)).toBe(90);
  });

  test('editing a product persists through the API and a reload', async ({ page, request }) => {
    const product = await createProduct(request, unique('Editable item'));
    const newName = unique('Edited item');
    await page.goto('/products');
    await searchProducts(page, product.name);
    await openProductActions(page, product);
    await page.getByRole('button', { name: 'Edit Product', exact: true }).click();

    const dialog = modal(page, `Edit Product: ${product.name}`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input').nth(1)).toHaveValue(product.sku); // SKU is read-only
    await expect(dialog.locator('input').nth(1)).toHaveAttribute('readonly', '');
    await dialog.locator('input').nth(0).fill(newName);
    await dialog.locator('input').nth(3).fill('120');
    await dialog.locator('input').nth(4).fill('70');
    // The MRP (last input) still holds 100: the form refuses an MRP below the new selling price until it is raised.
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('The MRP cannot be below the selling price.')).toBeVisible();
    await dialog.locator('input').last().fill('125');
    await dialog.getByLabel('GST Rate').selectOption('EIGHTEEN');
    await dialog.getByLabel('Unit').selectOption('LTR');

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/products/${product.id}`));
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByText(`${newName} updated`)).toBeVisible();

    await page.reload();
    await searchProducts(page, newName);
    await expect(page.getByTestId(`product-row-${product.id}`)).toContainText(newName);
    const stored = (await (await request.get(`${API_URL}/products/${product.id}`)).json()) as ApiProduct;
    expect(stored).toMatchObject({ name: newName, gstRate: 'EIGHTEEN', unit: 'LTR' });
    expect(Number(stored.sellingPrice)).toBe(120);
    expect(Number(stored.costPrice)).toBe(70);
  });

  test('deleting asks first, then removes the product on the server', async ({ page, request }) => {
    const product = await createProduct(request, unique('Deletable item'));
    await page.goto('/products');
    await searchProducts(page, product.name);

    let deletes = 0;
    page.on('request', (r) => {
      if (r.method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/products/${product.id}`)) deletes += 1;
    });
    await openProductActions(page, product);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = modal(page, 'Delete Product');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toBe(0);
    await expect(page.getByTestId(`product-row-${product.id}`)).toBeVisible();

    await openProductActions(page, product);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith(`/products/${product.id}`));
    await modal(page, 'Delete Product').getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await del).status()).toBe(204);
    await expect(page.getByText(`${product.name} deleted`)).toBeVisible();

    await page.reload();
    await searchProducts(page, product.name);
    await expect(page.getByText('No products found')).toBeVisible();
    expect((await request.get(`${API_URL}/products/${product.id}`)).status()).toBe(404);
  });
});

test.describe('settings page (6.3)', () => {
  test('the shop profile fields persist and the shop state decides IGST', async ({ page, request }) => {
    const email = `shop-${Date.now().toString(36)}@example.com`;
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Shop Profile' })).toBeVisible();
    await page.getByLabel('City').fill('Bengaluru');
    await page.getByLabel('State').selectOption('Karnataka');
    await page.getByLabel('PIN Code').fill('560001');
    await page.getByLabel('Phone').fill('9876543210');
    await page.getByLabel('Email').fill(email);

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/shops/me'));
    await page.getByRole('button', { name: 'Save Changes' }).click();
    const response = await patch;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210', email });
    await expect(page.getByText('Sales to customers outside Karnataka will carry IGST', { exact: false })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('City')).toHaveValue('Bengaluru');
    await expect(page.getByLabel('State')).toHaveValue('Karnataka');
    await expect(page.getByLabel('PIN Code')).toHaveValue('560001');
    await expect(page.getByLabel('Phone')).toHaveValue('9876543210');
    await expect(page.getByLabel('Email')).toHaveValue(email);
    const me = (await (await request.get(`${API_URL}/shops/me`)).json()) as { city: string; state: string; pincode: string; phone: string; email: string };
    expect(me).toMatchObject({ city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210', email });

    // The saved state is what the checkout math uses: a Delhi customer is charged IGST, a Karnataka one CGST + SGST.
    const product = await createProduct(request, unique('Taxed item'));
    const phone = () => String(7_000_000_000 + Math.floor(Math.random() * 999_999_999));
    const delhi = await (await request.post(`${API_URL}/customers`, { data: { name: unique('Delhi buyer'), phone: phone(), state: 'Delhi' } })).json();
    const local = await (await request.post(`${API_URL}/customers`, { data: { name: unique('Local buyer'), phone: phone(), state: 'Karnataka' } })).json();
    const calc = async (customerId: string) => (await request.post(`${API_URL}/billing/calculate`, { data: { items: [{ productId: product.id, quantity: 1 }], customerId } })).json();
    expect(await calc(delhi.id)).toMatchObject({ isInterState: true, shopState: 'Karnataka', customerState: 'Delhi' });
    expect(await calc(local.id)).toMatchObject({ isInterState: false });

    // A 6-digit PIN is enforced before anything is sent.
    await page.getByLabel('PIN Code').fill('12');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('The PIN code must be 6 digits.')).toBeVisible();
  });

  test('the side menu opens real panels and pages', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('settings-menu').getByRole('button', { name: 'Billing & Plans' })).toHaveCount(0);

    const sessions = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth/sessions'));
    await page.getByRole('button', { name: 'Account & Security' }).click();
    expect((await sessions).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Account & Security' })).toBeVisible();
    await expect(page.getByText('Active sessions')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await page.getByRole('button', { name: 'Shop Profile' }).click();
    await expect(page.getByRole('heading', { name: 'Shop Profile' })).toBeVisible();

    const menu = page.getByTestId('settings-menu');
    await menu.getByRole('button', { name: 'Team Management' }).click();
    await page.waitForURL('**/employees');
    await page.goto('/settings');
    await menu.getByRole('button', { name: 'Notifications', exact: true }).click();
    await page.waitForURL('**/notifications');
  });
});

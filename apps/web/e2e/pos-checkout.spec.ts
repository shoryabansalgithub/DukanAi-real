import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import mysql from 'mysql2/promise';
import { money } from '../src/components/pos/format';

/**
 * Browser-level POS checkout (roadmap layer 6).
 *
 * Runs against the API + web servers started by playwright.config.ts with the
 * auth bypass on. Every test creates its own SERVICE product (no stock needed)
 * through `POST /api/products`, so a reset of `dukaanai_test` cannot break it.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'mysql://root:password@localhost:3306/dukaanai_test';

interface CreatedProduct {
  id: string;
  name: string;
  sku: string;
}

interface ApiInvoiceItem {
  id: string;
  productId: string | null;
  isCustom: boolean;
  productName: string;
  productSku: string;
  quantity: string | number;
  cessAmount: string | number;
  totalAmount: string | number;
}

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  totalAmount: string | number;
  changeAmount: string | number;
  paidAmount: string | number;
  items: ApiInvoiceItem[];
}

function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** "₹1,234.50" → 1234.5 (display parsing for the test only). */
function parseMoney(text: string): number {
  const value = Number(text.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(value)) throw new Error(`Not a money string: "${text}"`);
  return value;
}

async function createServiceProduct(request: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<CreatedProduct> {
  const name = unique('E2E Service');
  const sku = `E2E-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`;
  const res = await request.post(`${API_URL}/products`, {
    data: {
      name,
      sku,
      type: 'SERVICE',
      unit: 'PCS',
      gstRate: 'EIGHTEEN',
      costPrice: 100,
      sellingPrice: 199.5,
      mrp: 199.5,
      wholesalePrice: 150,
      ...overrides,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { id: string };
  return { id: body.id, name, sku };
}

/** Sets `Product.cessRate` directly: the product API has no cess field yet, and cess is what this parity check is about. */
async function setProductCess(productId: string, cessRate: number): Promise<void> {
  const conn = await mysql.createConnection(DATABASE_URL);
  try {
    await conn.execute('UPDATE Product SET cessRate = ? WHERE id = ?', [cessRate, productId]);
  } finally {
    await conn.end();
  }
}

async function openPos(page: Page): Promise<void> {
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
  // A cart left over in sessionStorage from a previous run would change the totals.
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
}

async function addProductViaSearch(page: Page, product: CreatedProduct): Promise<void> {
  const search = page.getByTestId('pos-search');
  // `fill` sets the value in one go, so the HID barcode-scanner heuristic never fires.
  await search.fill(product.name);
  const option = page.getByRole('option', { name: product.name }).first();
  await expect(option).toBeVisible();
  await expect(option).toBeEnabled();
  await option.click();
  const line = page.locator('[data-testid="cart-line"][data-custom="false"]', { hasText: product.name });
  await expect(line).toHaveCount(1);
  await expect(line.getByTestId('cart-line-total')).not.toHaveText('—');
}

async function addCustomItem(page: Page, item: { name: string; price: string; quantity: string }): Promise<void> {
  await page.getByTestId('pos-custom-item').click();
  await expect(page.getByTestId('custom-item-form')).toBeVisible();
  await expect(page.getByTestId('custom-item-gst')).toHaveValue('EIGHTEEN');
  await expect(page.getByTestId('custom-item-unit')).toHaveValue('PCS');
  await page.getByTestId('custom-item-name').fill(item.name);
  await page.getByTestId('custom-item-price').fill(item.price);
  await page.getByTestId('custom-item-quantity').fill(item.quantity);
  await page.getByTestId('custom-item-submit').click();
  await expect(page.getByTestId('custom-item-form')).toBeHidden();
  const line = page.locator('[data-testid="cart-line"][data-custom="true"]', { hasText: item.name });
  await expect(line).toHaveCount(1);
  await expect(line.getByTestId('cart-line-custom-badge')).toBeVisible();
  await expect(line.getByTestId('cart-line-total')).not.toHaveText('—');
}

interface CheckoutResult {
  invoiceId: string;
  receiptTotalText: string;
  receiptChangeText: string | null;
  /** Body of `POST /billing/invoice` as the browser received it. */
  createResponse: { invoice: ApiInvoice; stock: Array<{ productId: string | null }> };
}

/** Pays by cash (with change when `extraCash > 0`) and returns what the receipt modal shows. */
async function checkoutWithCash(page: Page, extraCash: number): Promise<CheckoutResult> {
  const grandTotalText = await page.getByTestId('pos-grand-total').innerText();
  const grandTotal = parseMoney(grandTotalText);
  expect(grandTotal).toBeGreaterThan(0);

  await page.getByTestId('pos-charge').click();
  await expect(page.getByTestId('payment-amount-due')).toHaveText(grandTotalText);

  const tendered = Math.ceil(grandTotal) + extraCash;
  await page.getByTestId('cash-tendered').fill(String(tendered));
  if (extraCash > 0) {
    await expect(page.getByTestId('cash-change')).not.toHaveText(money(0));
  }

  const responsePromise = page.waitForResponse(
    (res) => res.request().method() === 'POST' && /\/billing\/invoice$/.test(new URL(res.url()).pathname),
  );
  await page.getByTestId('payment-confirm').click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  const createResponse = (await response.json()) as CheckoutResult['createResponse'];

  const receipt = page.getByTestId('receipt-modal');
  await expect(receipt).toBeVisible();
  const invoiceId = await receipt.getAttribute('data-invoice-id');
  expect(invoiceId).toBeTruthy();
  const receiptTotalText = await page.getByTestId('receipt-total').innerText();
  const change = page.getByTestId('receipt-change');
  const receiptChangeText = (await change.count()) > 0 ? await change.innerText() : null;

  return { invoiceId: invoiceId as string, receiptTotalText, receiptChangeText, createResponse };
}

async function fetchInvoice(request: APIRequestContext, invoiceId: string): Promise<ApiInvoice> {
  const res = await request.get(`${API_URL}/billing/invoices/${invoiceId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as ApiInvoice;
}

test.describe('POS checkout', () => {
  test('product + custom item, cash with change: receipt total equals the API invoice', async ({ page, request }) => {
    const product = await createServiceProduct(request);
    const customName = unique('Gift wrap');

    await openPos(page);
    await addProductViaSearch(page, product);
    await addCustomItem(page, { name: customName, price: '49.5', quantity: '2' });

    const result = await checkoutWithCash(page, 100);

    // The receipt modal shows exactly what the API stored.
    const invoice = await fetchInvoice(request, result.invoiceId);
    expect(result.receiptTotalText).toBe(money(Number(invoice.totalAmount)));
    expect(result.receiptChangeText).toBe(money(Number(invoice.changeAmount)));
    expect(Number(invoice.changeAmount)).toBeGreaterThan(0);
    expect(page.getByTestId('receipt-invoice-number')).toHaveText(invoice.invoiceNumber);

    // Custom line: isCustom, no product, CUSTOM sku, priced as typed.
    const customLine = invoice.items.find((item) => item.productName === customName);
    expect(customLine, JSON.stringify(invoice.items)).toBeDefined();
    expect(customLine!.isCustom).toBe(true);
    expect(customLine!.productId).toBeNull();
    expect(customLine!.productSku).toBe('CUSTOM');
    expect(Number(customLine!.quantity)).toBe(2);

    // Product line is a normal catalogue line.
    const productLine = invoice.items.find((item) => item.productId === product.id);
    expect(productLine, JSON.stringify(invoice.items)).toBeDefined();
    expect(productLine!.isCustom).toBe(false);
    expect(invoice.items).toHaveLength(2);

    // The stock array of the create response never lists the custom line.
    expect(result.createResponse.stock.some((row) => row.productId === null)).toBe(false);

    // The invoice page renders the custom line with its badge.
    await page.goto(`/invoices/${result.invoiceId}`);
    const renderedCustom = page.locator('[data-testid="invoice-item"][data-custom="true"]');
    await expect(renderedCustom).toHaveCount(1);
    await expect(renderedCustom.getByTestId('custom-item-badge')).toBeVisible();
    await expect(renderedCustom).toContainText(customName);
  });

  test('cess parity: a product with cess previews and settles at the API total', async ({ page, request }) => {
    const product = await createServiceProduct(request, { sellingPrice: 120, mrp: 120 });
    await setProductCess(product.id, 12.5);

    await openPos(page);
    await addProductViaSearch(page, product);

    // Exact cash: any drift between the web preview and the API engine would be
    // rejected server-side as ERR_PAYMENT_MISMATCH and no invoice would exist.
    const result = await checkoutWithCash(page, 0);
    const invoice = await fetchInvoice(request, result.invoiceId);

    expect(result.receiptTotalText).toBe(money(Number(invoice.totalAmount)));
    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].productId).toBe(product.id);
    expect(Number(invoice.items[0].cessAmount)).toBeGreaterThan(0);
  });
});

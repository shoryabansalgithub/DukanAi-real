import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Inventory › Batches & Expiry (release audit, 2026-10-12): the Filters menu's
 * expiry checkboxes did nothing. Each one now narrows the list to batches in
 * that state, by the same rule as the row's status badge, and they combine
 * with the search.
 */

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_API_PORT ?? 3003}/api`;

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, expected = 201): Promise<T> {
  expect(res.status(), await res.text()).toBe(expected);
  return (await res.json()) as T;
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test('the expiry filters narrow the batch list to the ticked states and combine with the search', async ({ page, request }) => {
  const stamp = `EXP-${Date.now().toString(36)}`;
  const product = await json<{ id: string }>(
    await request.post(`${API_URL}/products`, { data: { name: `Expiry item ${stamp}`, unit: 'PCS', gstRate: 'ZERO', costPrice: 10, sellingPrice: 20, mrp: 20 } }),
  );
  const item = await json<{ id: string }>(await request.post(`${API_URL}/inventory-domain`, { data: { productId: product.id } }));

  const batches = {
    expired: { batchNumber: `${stamp}-OLD`, expiryDate: inDays(-5), stock: 4 },
    soon: { batchNumber: `${stamp}-SOON`, expiryDate: inDays(10), stock: 4 },
    safe: { batchNumber: `${stamp}-SAFE`, expiryDate: inDays(200), stock: 4 },
    depleted: { batchNumber: `${stamp}-EMPTY`, expiryDate: inDays(200), stock: 0 },
  };
  for (const batch of Object.values(batches)) {
    const created = await json<{ id: string }>(
      await request.post(`${API_URL}/batches`, { data: { productId: product.id, batchNumber: batch.batchNumber, type: 'PURCHASE', expiryDate: batch.expiryDate } }),
    );
    if (batch.stock > 0) {
      await json(await request.post(`${API_URL}/batches/${created.id}/stock`, { data: { inventoryItemId: item.id, quantity: batch.stock } }));
    }
  }

  await page.goto('/inventory');
  await page.getByPlaceholder('Search by product, batch no, or SKU...').fill(stamp);
  const rows = page.locator('tbody tr');
  const shown = async () => (await rows.allInnerTexts()).map((text) => text.match(new RegExp(`${stamp}-[A-Z]+`))?.[0]).filter(Boolean).sort();
  const all = Object.values(batches).map((b) => b.batchNumber).sort();
  await expect.poll(shown).toEqual(all);

  // Each row's badge is the state its filter selects.
  for (const [key, label] of [['expired', 'Expired'], ['soon', 'Expiring Soon'], ['safe', 'Safe'], ['depleted', 'Depleted']] as const) {
    await expect(rows.filter({ hasText: batches[key].batchNumber }).getByText(label, { exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: /^Filters/ }).click();
  const box = (name: string) => page.getByRole('checkbox', { name });

  await box('Show Expired').check();
  await expect.poll(shown).toEqual([batches.expired.batchNumber]);
  await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();

  await box('Expiring < 30 Days').check();
  await expect.poll(shown).toEqual([batches.expired.batchNumber, batches.soon.batchNumber].sort());

  await box('Show Expired').uncheck();
  await box('Expiring < 30 Days').uncheck();
  await box('Safe').check();
  await expect.poll(shown).toEqual([batches.safe.batchNumber]);

  await box('Depleted (no stock)').check();
  await expect.poll(shown).toEqual([batches.depleted.batchNumber, batches.safe.batchNumber].sort());

  // A search that matches none of the ticked states says so.
  await page.getByPlaceholder('Search by product, batch no, or SKU...').fill(`${stamp}-OLD`);
  await expect(page.getByText('No batches match the search or the expiry filters.')).toBeVisible();

  // Typing in the search box leaves the Filters menu open.
  await page.getByPlaceholder('Search by product, batch no, or SKU...').fill(stamp);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  await expect.poll(shown).toEqual(all);
});

import { expect, test, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Roadmap 9.17, the browser half of the simulated business day: for every
 * shop the driver (apps/api/load/business-day.mjs) prepared, two sessions in
 * a real browser do through the UI what the API sessions do over HTTP, for
 * the whole compressed day:
 *
 *   - the OWNER signs in, lives on the dashboard (its 30 s poll), walks the
 *     invoice and customer lists, cancels a recent sale from the invoice page
 *     and records a repayment on a credit customer's page;
 *   - a CASHIER signs in, opens the drawer from the shift banner, bills cash,
 *     UPI and credit sales (with a line discount now and then) from the POS,
 *     returns one unit from the invoice page every few sales, and closes the
 *     drawer at closing time.
 *
 * A failed checkout (the instance was killed, the network dropped) is
 * retried the way a cashier does it: the Retry button, which reuses the
 * request key, until the receipt appears. Every outcome is written to the
 * UI report the driver merges into its gate (the invoice ids the browser
 * sessions created must all be on the API, and nothing else).
 */
interface ShopState {
  index: number;
  shopId: string;
  name: string;
  owner: { email: string; password: string };
  cashier: { id: string; email: string; password: string } | null;
  products: Array<{ id: string; name: string; sku: string; price: number }>;
  customers: Array<{ id: string; name: string; credit: boolean }>;
}
interface DayState {
  webUrl: string;
  apiUrl: string;
  startedAt: string;
  endsAt: string;
  minutes: number;
  uiReportFile: string;
  shops: ShopState[];
}
interface ShopOutcome {
  index: number;
  sales: Array<{ invoiceId: string; invoiceNumber: string | null; tender: string; attempts: number }>;
  returns: Array<{ invoiceId: string; originalId: string }>;
  cancellations: Array<{ invoiceId: string }>;
  repayments: Array<{ customerId: string; amount: number }>;
  shift: string;
  api5xx: number;
  /** Times a session found itself on the login page and signed in again (a lost session is a finding). */
  signedInAgain: number;
  errors: string[];
  fatal: string | null;
}

const STATE_FILE = process.env.BUSINESS_DAY_STATE_FILE ?? '../api/load/.business-day.state.json';

/** One line per problem, with the clock and where the page was: the report is read long after the run. */
function note(outcome: ShopOutcome, page: Page, what: string): void {
  outcome.errors.push(`${new Date().toISOString()} ${what.replace(/\s+/g, ' ').slice(0, 220)} @ ${page.url()}`);
}

/** True when the session was bounced to the login page (the middleware found no valid session). */
function bounced(page: Page): boolean {
  return /\/login(\?|$)/.test(page.url());
}
const UI_SHOPS = Number(process.env.BUSINESS_DAY_UI_SHOPS ?? 0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const chance = (percent: number) => Math.random() * 100 < percent;

async function waitForState(): Promise<DayState> {
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DayState;
    await sleep(3000);
  }
  throw new Error(`the driver did not write ${STATE_FILE} within 10 minutes`);
}

/**
 * The login form is a client component: a value typed before React has
 * hydrated the page is wiped by the hydration (the sign-in then goes out with
 * empty credentials and is refused in a few milliseconds). So: let the page
 * settle, fill, prove the values are still there a moment later, submit, and
 * start over when the page is still on /login after a while.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  for (let round = 1; ; round++) {
    await page.goto('/login');
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
    const emailField = page.getByPlaceholder('admin@dukaan.ai');
    const passwordField = page.getByPlaceholder('••••••••');
    await emailField.fill(email);
    await passwordField.fill(password);
    await sleep(1500);
    if ((await emailField.inputValue()) !== email || (await passwordField.inputValue()) !== password) {
      await emailField.fill(email);
      await passwordField.fill(password);
    }
    await page.locator('form button[type="submit"]').click();
    const landed = await page.waitForURL('**/dashboard', { timeout: 45_000 }).then(() => true).catch(() => false);
    if (landed) return;
    if (round >= 4) throw new Error(`sign-in of ${email} did not reach the dashboard after ${round} rounds (last URL ${page.url()})`);
  }
}

/** Counts every 5xx the API answered to this page (an edge's empty 502 during the kill has no JSON body and is not counted). */
function watch5xx(page: Page, outcome: ShopOutcome): void {
  page.on('response', (res) => {
    if (res.status() >= 500 && /\/api\//.test(res.url())) {
      res
        .text()
        .then((text) => {
          if (text.trim().startsWith('{')) outcome.api5xx += 1;
        })
        .catch(() => undefined);
    }
  });
}

function modal(page: Page, title: string | RegExp) {
  return page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: title }) });
}

async function ensureDrawerOpen(page: Page, outcome: ShopOutcome): Promise<void> {
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
  // The banner reads GET /shifts/current first; decide once it says one thing or the other
  // ("No open shift" nests a longer sentence, so it is matched as a substring).
  const noShift = page.getByText('No open shift');
  const open = page.getByText('Shift open', { exact: true });
  await expect(noShift.or(open).first()).toBeVisible({ timeout: 30_000 });
  if (await noShift.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Open shift' }).click();
    const open = modal(page, 'Open shift');
    await expect(open).toBeVisible();
    await open.locator('#opening-cash').fill('2000');
    await open.getByRole('button', { name: 'Open shift' }).click();
    await expect(page.getByText('Shift opened')).toBeVisible();
    outcome.shift = 'opened';
  } else {
    outcome.shift = 'already open';
  }
}

async function addProduct(page: Page, product: ShopState['products'][number]): Promise<void> {
  const search = page.getByTestId('pos-search');
  await search.fill(product.name);
  const option = page.getByRole('option', { name: product.name }).first();
  await expect(option).toBeVisible();
  await option.click();
  const line = page.locator('[data-testid="cart-line"][data-custom="false"]', { hasText: product.name });
  await expect(line.first()).toBeVisible();
  await expect(line.first().getByTestId('cart-line-total')).not.toHaveText('—');
}

async function chooseCustomer(page: Page, customer: ShopState['customers'][number]): Promise<void> {
  const search = page.getByLabel('Search customers');
  await search.fill(customer.name);
  const option = page.getByRole('listbox', { name: 'Matching customers' }).getByRole('option', { hasText: customer.name }).first();
  await expect(option).toBeVisible();
  await option.click();
}

/** One sale from the POS; returns the invoice id the receipt carries. Retries through the panel's own Retry button. */
async function uiSale(page: Page, shop: ShopState, outcome: ShopOutcome): Promise<string | null> {
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible();
  const lines = 1 + Math.floor(Math.random() * 2);
  const chosen = [...shop.products].sort(() => Math.random() - 0.5).slice(0, lines);
  for (const product of chosen) await addProduct(page, product);
  if (chance(30)) {
    await page.getByLabel(`Line discount percent for ${chosen[0].name}`).fill('5');
  }
  const r = Math.random() * 100;
  const tender = r < 55 ? 'CASH' : r < 85 ? 'UPI' : 'CREDIT';
  if (tender === 'CREDIT') await chooseCustomer(page, pick(shop.customers.filter((c) => c.credit)));
  const grandTotalText = await page.getByTestId('pos-grand-total').innerText();
  const grandTotal = Number(grandTotalText.replace(/[^\d.-]/g, ''));
  await page.getByTestId('pos-charge').click();
  await expect(page.getByTestId('payment-amount-due')).toBeVisible();
  const methods = page.getByRole('radiogroup', { name: 'Payment method' });
  if (tender === 'CASH') {
    await page.getByTestId('cash-tendered').fill(String(Math.ceil(grandTotal / 10) * 10));
  } else if (tender === 'UPI') {
    await methods.getByRole('radio', { name: 'UPI' }).click();
    await page.locator('#tender-reference').fill(`UPI${Math.floor(Math.random() * 1e6)}`);
  } else {
    await methods.getByRole('radio', { name: 'Credit (udhar)' }).click();
  }
  await page.getByTestId('payment-confirm').click();
  const receipt = page.getByTestId('receipt-modal');
  let attempts = 1;
  for (;;) {
    const settled = await Promise.race([
      receipt.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'receipt' as const),
      page.getByRole('button', { name: 'Retry' }).waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'retry' as const),
    ]).catch(() => 'timeout' as const);
    if (settled === 'receipt') break;
    if (attempts >= 8) throw new Error(`checkout did not settle after ${attempts} attempts (${settled})`);
    attempts += 1;
    await sleep(5000);
    const retry = page.getByRole('button', { name: 'Retry' });
    if (await retry.isVisible().catch(() => false)) await retry.click();
    else if (await receipt.isVisible().catch(() => false)) break;
    else {
      // The panel shows a non-retryable refusal (credit limit, stock): abandon this sale.
      const refusal = await page.locator('.text-red-800').first().innerText().catch(() => '');
      note(outcome, page, `sale refused: ${refusal}`);
      return null;
    }
  }
  const invoiceId = await receipt.getAttribute('data-invoice-id');
  const invoiceNumber = await page.getByTestId('receipt-invoice-number').innerText().catch(() => null);
  if (invoiceId) outcome.sales.push({ invoiceId, invoiceNumber, tender, attempts });
  await page.getByTestId('receipt-new-sale').click();
  return invoiceId;
}

/** Opens an invoice page and waits for its document heading (the action buttons render with it). */
async function openInvoice(page: Page, invoiceId: string): Promise<void> {
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByRole('heading', { name: /^(INV|RET)-/ })).toBeVisible({ timeout: 30_000 });
}

async function uiReturn(page: Page, invoiceId: string, outcome: ShopOutcome): Promise<void> {
  await openInvoice(page, invoiceId);
  const button = page.getByRole('button', { name: 'Return', exact: true });
  if (!(await button.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) return;
  await button.click();
  const dialog = page.locator('div.rounded-2xl').filter({ has: page.getByRole('heading', { name: /^Return items/ }) });
  await expect(dialog).toBeVisible();
  // The dialog's lines come from GET /billing/invoices/:id; the first line that still has
  // something to return takes one unit, and the submit enables once the engine preview is in.
  const quantity = dialog.getByLabel(/^Return quantity for /).and(dialog.locator('input:enabled')).first();
  await expect(quantity).toBeVisible({ timeout: 30_000 });
  await quantity.fill('1');
  const submit = dialog.getByRole('button', { name: /^Return 1 item/ });
  try {
    await expect(submit).toBeEnabled({ timeout: 30_000 });
  } catch {
    const alert = await dialog.getByRole('alert').allInnerTexts().catch(() => []);
    const label = await dialog.getByRole('button', { name: /^(Return|Processing)/ }).allInnerTexts().catch(() => []);
    note(outcome, page, `return: submit not enabled (buttons ${JSON.stringify(label)}, alert ${JSON.stringify(alert)})`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => undefined);
    return;
  }
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/billing\/returns$/.test(new URL(r.url()).pathname), { timeout: 45_000 });
  await submit.click();
  const res = await posted;
  if (res.status() === 201 || res.status() === 200) {
    const body = (await res.json()) as { invoice?: { id: string }; id?: string };
    const id = body.invoice?.id ?? body.id;
    if (id) outcome.returns.push({ invoiceId: id, originalId: invoiceId });
  } else note(outcome, page, `return answered ${res.status()}`);
}

async function uiCancel(page: Page, invoiceId: string, outcome: ShopOutcome): Promise<void> {
  await openInvoice(page, invoiceId);
  const button = page.getByRole('button', { name: 'Cancel', exact: true });
  if (!(await button.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) return;
  await button.click();
  await page.getByLabel('Cancellation reason').fill('Billed to the wrong customer');
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/billing/invoices/${invoiceId}/cancel`), { timeout: 45_000 });
  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  const res = await posted;
  if (res.status() === 200 || res.status() === 201) outcome.cancellations.push({ invoiceId });
  else if (res.status() >= 500) note(outcome, page, `cancel answered ${res.status()}`);
}

async function uiRepayment(page: Page, customer: ShopState['customers'][number], outcome: ShopOutcome): Promise<void> {
  await page.goto(`/customers/${customer.id}`);
  const button = page.getByRole('button', { name: 'Record payment' });
  await expect(button).toBeVisible();
  const outstandingBlock = page.locator('div', { has: page.getByText('Outstanding', { exact: true }) }).last();
  const outstanding = Number((await outstandingBlock.getByRole('heading').innerText().catch(() => '0')).replace(/[^\d.-]/g, ''));
  if (!(outstanding > 0)) return;
  const amount = Math.max(1, Math.min(outstanding, Math.round(100 + Math.random() * 900)));
  await button.click();
  const dialog = modal(page, /^Record payment/);
  await expect(dialog).toBeVisible();
  await dialog.locator('#payment-amount').fill(String(amount));
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/customers/${customer.id}/payments`), { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  const res = await posted;
  if (res.status() === 201 || res.status() === 200) outcome.repayments.push({ customerId: customer.id, amount });
  else if (res.status() >= 500) note(outcome, page, `repayment answered ${res.status()}`);
}

async function closeDrawer(page: Page, outcome: ShopOutcome): Promise<void> {
  await page.goto('/billing');
  await expect(page.getByText('No open shift').or(page.getByText('Shift open', { exact: true })).first()).toBeVisible({ timeout: 30_000 });
  const button = page.getByRole('button', { name: 'Close shift' });
  if (!(await button.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) return;
  await button.click();
  const close = modal(page, 'Close shift');
  await expect(close).toBeVisible();
  await close.locator('#closing-cash').fill('2000');
  await close.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift closed' })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  outcome.shift = 'closed';
}

async function cashierSession(browser: Browser, shop: ShopState, endsAt: number, outcome: ShopOutcome, shared: { lastSaleId: string | null }): Promise<void> {
  if (!shop.cashier) return;
  const context = await browser.newContext();
  const page = await context.newPage();
  watch5xx(page, outcome);
  try {
    await signIn(page, shop.cashier.email, shop.cashier.password);
    await ensureDrawerOpen(page, outcome);
    let n = 0;
    while (Date.now() < endsAt - 60_000) {
      try {
        if (bounced(page)) {
          note(outcome, page, 'cashier: session lost, signing in again');
          outcome.signedInAgain += 1;
          await signIn(page, shop.cashier.email, shop.cashier.password);
          await ensureDrawerOpen(page, outcome);
        }
        const id = await uiSale(page, shop, outcome);
        n += 1;
        if (id) {
          shared.lastSaleId = id;
          if (n % 5 === 0) await uiReturn(page, id, outcome);
        }
      } catch (error) {
        note(outcome, page, `cashier: ${String((error as Error).message ?? error)}`);
        await page.goto('/billing').catch(() => undefined);
      }
      await sleep(Math.min(Math.max(0, endsAt - 60_000 - Date.now()), 60_000 + Math.random() * 40_000));
    }
    await closeDrawer(page, outcome);
  } catch (error) {
    outcome.fatal = `cashier: ${String((error as Error).message ?? error).slice(0, 300)}`;
  } finally {
    await context.close();
  }
}

async function ownerSession(browser: Browser, shop: ShopState, endsAt: number, outcome: ShopOutcome, shared: { lastSaleId: string | null }): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  watch5xx(page, outcome);
  try {
    await signIn(page, shop.owner.email, shop.owner.password);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    let tick = 0;
    while (Date.now() < endsAt - 30_000) {
      await sleep(Math.min(Math.max(0, endsAt - 30_000 - Date.now()), 120_000));
      if (Date.now() >= endsAt - 30_000) break;
      tick += 1;
      try {
        if (bounced(page)) {
          note(outcome, page, 'owner: session lost, signing in again');
          outcome.signedInAgain += 1;
          await signIn(page, shop.owner.email, shop.owner.password);
        }
        if (tick % 4 === 1) {
          await page.goto('/invoices');
          await sleep(5000);
          await page.goto('/dashboard');
        } else if (tick % 4 === 2 && shared.lastSaleId) {
          const id = shared.lastSaleId;
          shared.lastSaleId = null;
          await uiCancel(page, id, outcome);
          await page.goto('/dashboard');
        } else if (tick % 4 === 3) {
          await uiRepayment(page, pick(shop.customers.filter((c) => c.credit)), outcome);
          await page.goto('/dashboard');
        } else {
          await page.goto('/customers');
          await sleep(5000);
          await page.goto('/dashboard');
        }
      } catch (error) {
        note(outcome, page, `owner: ${String((error as Error).message ?? error)}`);
        await page.goto('/dashboard').catch(() => undefined);
      }
    }
  } catch (error) {
    outcome.fatal = `owner: ${String((error as Error).message ?? error).slice(0, 300)}`;
  } finally {
    await context.close();
  }
}

test('two browser sessions per shop work through the UI for the whole business day', async ({ browser }) => {
  const state = await waitForState();
  const shops = state.shops.slice(0, UI_SHOPS || state.shops.length);
  const endsAt = Date.parse(state.endsAt);
  const outcomes: ShopOutcome[] = shops.map((shop) => ({ index: shop.index, sales: [], returns: [], cancellations: [], repayments: [], shift: 'not opened', api5xx: 0, signedInAgain: 0, errors: [], fatal: null }));
  const write = () => writeFileSync(state.uiReportFile, JSON.stringify({ finishedAt: new Date().toISOString(), shops: outcomes }, null, 2));
  const progress = setInterval(write, 60_000);
  try {
    await Promise.all(
      shops.flatMap((shop, i) => {
        const shared = { lastSaleId: null as string | null };
        return [cashierSession(browser, shop, endsAt, outcomes[i], shared), ownerSession(browser, shop, endsAt, outcomes[i], shared)];
      }),
    );
  } finally {
    clearInterval(progress);
    write();
  }
  const fatal = outcomes.filter((o) => o.fatal);
  expect(fatal, fatal.map((o) => `shop ${o.index}: ${o.fatal}`).join('\n')).toHaveLength(0);
  expect(outcomes.reduce((n, o) => n + o.api5xx, 0)).toBe(0);
});

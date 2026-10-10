import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Roadmap 9.18, the screen half of a failure drill. While
 * scripts/drills/drill.mjs injects a fault into the running system, two
 * browser sessions of the drill shop's owner keep working:
 *
 *   - at the POS, one cash sale after another; a failed checkout is handled
 *     the way a cashier does it (the panel's Retry button when it offers one,
 *     otherwise Pay again, which keeps the same request key);
 *   - on the dashboard, left open as an owner leaves it (its own 30-second
 *     polling); it is read every 10 s, also while a sale is being retried;
 *   - in Smart Capture, a bill photo saved every 20 s (picked through the
 *     gallery input, "Save Original Photo"); a failed save is saved again on
 *     the next turn, as a person would press the button again;
 *   - a second cashier who opens the POS the moment the fault is in place
 *     (the driver writes <DRILL_OBSERVER_STOP_FILE>.fault after its fault
 *     hook) and touches nothing: what a page loaded mid-incident says, and
 *     when it has its shop, shift and products without a click.
 *
 * Every change of what a screen says is one JSON line in DRILL_OBSERVER_REPORT
 * (the error text, whether Retry was offered, a screenshot the first time a
 * text appears); every receipt carries its invoice id, which the driver adds
 * to the sales it accounts for. On the dashboard the status badges count too
 * ("Refresh failed — showing last data", with the error its tooltip carries):
 * a failed poll keeps the last figures and says so there, not in an alert.
 * The run ends when DRILL_OBSERVER_STOP_FILE appears, with a final
 * {"kind":"done"} line.
 */
const STATE_FILE = process.env.DRILL_STATE_FILE ?? '';
const REPORT = process.env.DRILL_OBSERVER_REPORT ?? '';
const STOP_FILE = process.env.DRILL_OBSERVER_STOP_FILE ?? '';
const SHOTS = process.env.DRILL_OBSERVER_SHOTS ?? (REPORT ? `${REPORT.replace(/\.jsonl$/, '')}-shots` : 'drill-shots');

type Event = { view: 'pos' | 'pos-opened-mid-incident' | 'dashboard' | 'capture'; kind: string; text?: string; retry?: boolean; invoiceId?: string; attempts?: number; screenshot?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stopRequested = () => Boolean(STOP_FILE) && existsSync(STOP_FILE);
const seen = new Set<string>();

async function emit(page: Page | null, event: Event): Promise<void> {
  const line: Record<string, unknown> = { t: Date.now(), ...event };
  const key = `${event.view}|${event.kind}|${event.text ?? ''}`;
  if (page && event.kind !== 'receipt' && event.kind !== 'stored' && !seen.has(key)) {
    seen.add(key);
    mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, `${event.view}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false }).then(() => { line.screenshot = path.basename(file); }).catch(() => undefined);
  }
  if (REPORT) appendFileSync(REPORT, `${JSON.stringify(line)}\n`);
}

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
    if (await page.waitForURL('**/dashboard', { timeout: 45_000 }).then(() => true).catch(() => false)) return;
    if (round >= 6) throw new Error(`sign-in did not reach the dashboard after ${round} rounds`);
  }
}

/** Visible text of every alert on the page, one string (what a person reads at a glance). */
async function alertsOf(page: Page): Promise<string> {
  const texts = await page.locator('[role="alert"]').allInnerTexts().catch(() => [] as string[]);
  return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).sort().join(' | ');
}

/** What the page's content area says (a page whose own load failed shows its error there, not in an alert). */
async function contentTextOf(page: Page): Promise<string> {
  const text = await page.locator('main').first().innerText({ timeout: 2_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The dashboard's alerts and status badges; a badge's tooltip (the error behind it) in brackets. */
async function dashboardTextOf(page: Page): Promise<string> {
  const texts = await page
    .locator('[role="alert"]:visible, [role="status"]:visible')
    .evaluateAll((nodes) => nodes.map((node) => {
      const text = (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
      const detail = node.getAttribute('title');
      return detail ? `${text} [${detail.replace(/\s+/g, ' ').trim()}]` : text;
    }))
    .catch(() => [] as string[]);
  return [...new Set(texts.filter(Boolean))].sort().join(' | ');
}

let dashboardPage: Page | null = null;
let lastDashboard = '';
let nextDashboardCheck = 0;

/** At most every 10 s: record the dashboard's state when it changed. */
async function checkDashboard(): Promise<void> {
  if (!dashboardPage || Date.now() < nextDashboardCheck) return;
  nextDashboardCheck = Date.now() + 10_000;
  const text = (await dashboardTextOf(dashboardPage)) || 'every card loaded';
  if (text !== lastDashboard) await emit(dashboardPage, { view: 'dashboard', kind: text === 'every card loaded' ? 'ok' : 'error', text });
  lastDashboard = text;
}

let capturePage: Page | null = null;
let captureFailing = false;
let captureAttempts = 0;
let lastCaptureText = '';
let nextCapture = 0;

/** The toast a save leaves (the toasts carry no role and go after 3 s): its text, or '' after 30 s. */
async function toastAfter(page: Page, action: () => Promise<void>): Promise<string> {
  const toasts = page.locator('div.fixed.bottom-4.right-4 p');
  const before = await toasts.count().catch(() => 0);
  await action();
  const next = toasts.nth(before);
  if (!(await next.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false))) return '';
  return ((await next.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
}

/** At most every 20 s: save one bill photo in Smart Capture, or save the failed one again. */
async function checkCapture(): Promise<void> {
  if (!capturePage || Date.now() < nextCapture) return;
  nextCapture = Date.now() + 20_000;
  const page = capturePage;
  const save = page.getByRole('button', { name: /Save Original Photo/ });
  let text = '';
  try {
    if (!captureFailing || !(await save.isVisible().catch(() => false))) {
      await page.goto('/smart-capture', { timeout: 30_000 });
      const input = page.getByTestId('gallery-input');
      await input.waitFor({ state: 'attached', timeout: 30_000 });
      const bytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 120; canvas.height = 80;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#f7f3ea'; ctx.fillRect(0, 0, 120, 80);
        ctx.fillStyle = '#222'; ctx.fillText(`drill bill ${Date.now()}`, 8, 40);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      });
      await input.setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });
      await save.waitFor({ state: 'visible', timeout: 15_000 });
    }
    text = await toastAfter(page, () => save.click({ timeout: 10_000 }));
  } catch (error) {
    // The page could not offer the gallery or Save (its customer list did not load, for one): record what it says.
    text = (await alertsOf(page)) || (await contentTextOf(page)) || String((error as Error).message).split('\n')[0].slice(0, 200);
  }
  captureAttempts += 1;
  if (/^Bill stored/.test(text)) {
    await emit(page, { view: 'capture', kind: 'stored', attempts: captureAttempts });
    if (captureFailing) await emit(page, { view: 'capture', kind: 'recovered', text: `stored after ${captureAttempts} attempts` });
    captureFailing = false; captureAttempts = 0; lastCaptureText = '';
    return;
  }
  const shown = text || 'no answer on screen for 30 s';
  if (shown !== lastCaptureText) await emit(page, { view: 'capture', kind: 'error', text: shown });
  lastCaptureText = shown;
  captureFailing = true;
}

/** The second cashier: waits for the fault, opens the POS, watches it until it has loaded (3 minutes at most). */
async function cashierArrivingMidIncident(context: BrowserContext, startedAt: number): Promise<void> {
  const faultFile = `${STOP_FILE}.fault`;
  const faultSignalled = () => existsSync(faultFile) && Date.parse(readFileSync(faultFile, 'utf8').trim()) >= startedAt;
  while (!stopRequested() && !faultSignalled()) await sleep(250);
  if (stopRequested()) return;
  const page = await context.newPage();
  const openedAt = Date.now();
  const view = 'pos-opened-mid-incident' as const;
  const after = () => `${((Date.now() - openedAt) / 1000).toFixed(1)} s after it was opened`;
  await page.goto('/billing', { timeout: 60_000 }).catch(() => undefined);
  let last = '';
  while (!stopRequested() && Date.now() - openedAt < 180_000) {
    const text = await alertsOf(page);
    const loaded = !text && (await page.getByRole('option').first().isVisible().catch(() => false));
    if (loaded) {
      await emit(page, { view, kind: last ? 'recovered' : 'ok', text: last ? `shop, shift and products loaded ${after()}, no click` : `loaded normally ${after()}` });
      break;
    }
    if (text && text !== last) await emit(page, { view, kind: 'error', text });
    if (text) last = text;
    await sleep(500);
  }
  await page.close().catch(() => undefined);
}

/** One sale at the POS, retried until the receipt shows; returns false when the page itself could not be used. */
async function sale(page: Page, productName: string, price: number): Promise<boolean> {
  try {
    await page.goto('/billing', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Point of Sale' })).toBeVisible({ timeout: 30_000 });
    const search = page.getByTestId('pos-search').filter({ visible: true }).first();
    await search.fill(productName);
    const option = page.getByRole('option', { name: productName }).first();
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.click();
    await expect(page.locator('[data-testid="cart-line"]').first()).toBeVisible();
    await page.getByTestId('pos-charge').click();
    await page.getByTestId('cash-tendered').fill(String(price));
    await page.getByTestId('payment-confirm').click();
  } catch (error) {
    await emit(page, { view: 'pos', kind: 'page-error', text: (await alertsOf(page)) || String((error as Error).message).split('\n')[0].slice(0, 200) });
    return false;
  }
  const receipt = page.getByTestId('receipt-modal');
  const retry = page.getByRole('button', { name: 'Retry' });
  let lastText = '';
  for (let attempts = 1; ; attempts++) {
    const settled = await Promise.race([
      receipt.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'receipt' as const),
      page.locator('[role="alert"]').first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'alert' as const),
    ]).catch(() => 'nothing' as const);
    if (settled === 'alert') await sleep(600); // a transient alert (a toast) can come and go before the receipt
    if (settled === 'receipt' || (await receipt.isVisible().catch(() => false))) {
      const invoiceId = await receipt.getAttribute('data-invoice-id');
      await emit(page, { view: 'pos', kind: 'receipt', invoiceId: invoiceId ?? undefined, attempts });
      if (lastText) await emit(page, { view: 'pos', kind: 'recovered', text: `receipt after ${attempts} attempts` });
      await page.getByTestId('receipt-new-sale').click().catch(() => undefined);
      return true;
    }
    const text = settled === 'nothing' ? 'no answer on screen for 60 s (spinner)' : await alertsOf(page);
    if (!text) { attempts -= 1; continue; } // the alert went away on its own: not a failure the cashier saw
    const offersRetry = await retry.isVisible().catch(() => false);
    if (text !== lastText) await emit(page, { view: 'pos', kind: 'error', text, retry: offersRetry });
    lastText = text;
    if (stopRequested() && attempts > 40) return true;
    await checkDashboard();
    await checkCapture();
    await sleep(3000);
    if (offersRetry) await retry.click().catch(() => undefined);
    else await page.getByTestId('payment-confirm').click({ timeout: 5_000 }).catch(() => undefined);
  }
}

test('drill observer: the POS, the dashboard and Smart Capture while a fault is injected', async ({ browser }) => {
  test.skip(!STATE_FILE || !REPORT || !STOP_FILE, 'DRILL_STATE_FILE, DRILL_OBSERVER_REPORT and DRILL_OBSERVER_STOP_FILE are required');
  const startedAt = Date.now();
  while (!existsSync(STATE_FILE)) await sleep(2000);
  const account = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { email: string; password: string; productName?: string; price?: number };
  const context = await browser.newContext();
  const pos = await context.newPage();
  await signIn(pos, account.email, account.password);
  dashboardPage = await context.newPage();
  await dashboardPage.goto('/dashboard');
  capturePage = await context.newPage();
  const secondCashier = cashierArrivingMidIncident(context, startedAt);
  await emit(null, { view: 'pos', kind: 'ready' });

  while (!stopRequested()) {
    await checkDashboard();
    await checkCapture();
    const usable = await sale(pos, account.productName ?? 'Drill tea', account.price ?? 20);
    await sleep(usable ? 4000 : 8000);
  }
  await secondCashier;
  await emit(null, { view: 'pos', kind: 'done' });
  await context.close();
});

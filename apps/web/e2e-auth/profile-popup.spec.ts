import { expect, test, type Page } from '@playwright/test';

/**
 * The top bar's name and avatar open a profile popup (who is signed in, the
 * shop, Sign out as its last item) instead of signing the user out on any
 * click. Real session: the popup reads the NextAuth user and `GET /shops/me`.
 */

const PASSWORD = 'Str0ng-Passw0rd!';

async function registerOwner(page: Page): Promise<{ name: string; email: string; shopName: string }> {
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const owner = { name: 'Popup Owner', email: `popup-${id}@example.com`, shopName: `Popup Kirana ${id}` };
  await page.goto('/register');
  await page.getByPlaceholder('Rajesh Kumar').fill(owner.name);
  await page.getByPlaceholder('Kumar General Store').fill(owner.shopName);
  await page.getByPlaceholder('rajesh@example.com').fill(owner.email);
  await page.getByPlaceholder('Min. 12 characters').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Store' }).click();
  await page.waitForURL('**/dashboard');
  return owner;
}

async function sessionUser(page: Page): Promise<boolean> {
  return page.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((s) => Boolean(s && s.user)));
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`at ${viewport.width}px the name and avatar open a profile popup that closes every way and signs out only from its button`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const owner = await registerOwner(page);
    const trigger = page.getByRole('button', { name: `${owner.name}, account` });
    const popup = page.getByRole('dialog', { name: owner.name });

    // The bar carries no Sign Out text any more; clicking the name opens the popup and stays signed in.
    await expect(page.getByText('Sign Out', { exact: true })).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(popup).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(new URL(page.url()).pathname).toBe('/dashboard');
    expect(await sessionUser(page)).toBe(true);

    await expect(popup.getByText(owner.email)).toBeVisible();
    await expect(popup.getByText('Owner', { exact: true })).toBeVisible();
    await expect(popup.getByText(owner.shopName)).toBeVisible();
    // Sign out is the popup's last control, and the popup stays inside the viewport.
    await expect(popup.getByRole('button').last()).toHaveText('Sign out');
    const box = await popup.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

    // Escape closes it and gives focus back to the trigger.
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // A click outside closes it.
    await trigger.click();
    await expect(popup).toBeVisible();
    // The page gutter: at 390px the popup covers the heading.
    await page.mouse.click(8, 300);
    await expect(popup).toHaveCount(0);

    // The trigger toggles it.
    await trigger.click();
    await expect(popup).toBeVisible();
    await trigger.click();
    await expect(popup).toHaveCount(0);

    // Keyboard: Enter opens with focus on the panel (a second Enter cannot sign out), Tab reaches Sign out.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(popup).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await sessionUser(page)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(popup.getByRole('button', { name: 'Sign out' })).toBeFocused();

    await page.keyboard.press('Enter');
    await page.waitForURL('**/login**');
    await expect.poll(() => sessionUser(page)).toBe(false);
    await page.goto('/dashboard');
    await page.waitForURL('**/login?callbackUrl=%2Fdashboard');
  });
}

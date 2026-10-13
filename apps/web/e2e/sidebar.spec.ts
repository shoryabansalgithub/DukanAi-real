import { expect, test, type Page } from '@playwright/test';

/**
 * Sidebar (release audit, 2026-10-12): on a laptop or a phone the Upgrade
 * card pushed Notifications and Settings below the visible part of a menu
 * whose scrollbar was hidden. Now the list scrolls on its own, those two are
 * pinned under it and the card keeps its button at every height.
 */

const SIZES = [
  { width: 1280, height: 720, label: 'laptop 1280x720' },
  { width: 1366, height: 768, label: 'laptop 1366x768' },
  { width: 1440, height: 900, label: 'desktop 1440x900' },
  { width: 844, height: 390, label: 'phone on its side 844x390' },
  { width: 390, height: 844, label: 'phone 390x844' },
];

async function openMenu(page: Page, width: number) {
  if (width < 768) await page.getByRole('button', { name: 'Open menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  return nav;
}

for (const size of SIZES) {
  test(`Notifications, Settings and Upgrade stay on screen: ${size.label}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/dashboard');
    const nav = await openMenu(page, size.width);

    for (const name of ['Notifications', 'Settings']) {
      await expect(nav.getByRole('link', { name }), name).toBeInViewport({ ratio: 1 });
    }
    await expect(page.getByRole('button', { name: /Upgrade/ })).toBeInViewport({ ratio: 1 });

    // Every other link is reachable by scrolling the list itself.
    for (const name of ['Dashboard', 'Expenses', 'Reports & Analytics']) {
      const link = nav.getByRole('link', { name });
      await link.scrollIntoViewIfNeeded();
      await expect(link, name).toBeInViewport({ ratio: 1 });
    }

    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });
}

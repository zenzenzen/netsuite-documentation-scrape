const { test, expect } = require('playwright/test');

test('favorite state persists after reload', async ({ page }) => {
  await page.goto('/records/customer');
  await expect(page.locator('[data-nav-panel] .nav-link').first()).toBeVisible();

  const favoriteButton = page.locator('[data-favorite-toggle][data-record-name="customer"]').first();
  await favoriteButton.click();
  await expect(favoriteButton).toHaveText('Pinned favorite');

  await page.reload();
  await expect(page.locator('[data-nav-panel] .nav-link').first()).toBeVisible();

  await expect(page.locator('[data-favorite-toggle][data-record-name="customer"]').first()).toHaveText('Pinned favorite');
});

test('endpoint accordions still expand', async ({ page }) => {
  await page.goto('/records/customer');

  const firstEndpoint = page.locator('details.endpoint').first();
  expect(await firstEndpoint.evaluate((node) => node.open)).toBe(false);

  await firstEndpoint.locator('summary').click();
  await expect.poll(() => firstEndpoint.evaluate((node) => node.open)).toBe(true);
});

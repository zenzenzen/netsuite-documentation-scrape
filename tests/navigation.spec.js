const { test, expect } = require('playwright/test');

test('migrated and legacy dependency links resolve with the intended hrefs', async ({ page }) => {
  await page.goto('/records/account');

  await expect(page.locator('a[href="/records/currency"]').first()).toBeVisible();
  await expect(page.locator('a[href="/records/units-type"]').first()).toBeVisible();
});

test('overview and transforms navigation stays on Astro routes', async ({ page }) => {
  await page.goto('/records/customer');

  await page.getByRole('link', { name: /Overview/i }).first().click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: /Transforms/i }).first().click();
  await expect(page).toHaveURL('/transforms');
});

test('overview and transforms pages render route content', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href="/records/customer"]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recurring Billing' })).toBeVisible();
  await expect(page.locator('a[href="/records/subscription"]').first()).toBeVisible();
  await expect(page.locator('a[href="/records/billing-account"]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recurring Amount Field Explainers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Estimate.recurMonthly' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Opportunity.recurMonthly' })).toBeVisible();

  await page.goto('/transforms');
  await expect(page.locator('.matrix')).toBeVisible();
  await expect(page.locator('a[href="/records/customer"]').first()).toBeVisible();
});

test('record page workflow link anchors the current record', async ({ page }) => {
  await page.goto('/records/invoice');

  await page.getByRole('link', { name: 'Open in workflow studio' }).click();

  await expect(page).toHaveURL(/\/records\/invoice\?base=invoice#workflow-studio$/);
  await expect(page.locator('[data-workflow-base]')).toHaveValue('invoice');
});

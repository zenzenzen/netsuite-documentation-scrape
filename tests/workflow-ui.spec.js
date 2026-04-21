const { test, expect } = require('playwright/test');

async function anchorWorkflow(page, recordName = 'Customer') {
  await page.goto('/workflow');
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible();
  await page.locator('.workflow-node-button', { hasText: recordName }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(`${recordName} transform atlas`, 'i') })).toBeVisible();
}

test('frontier pills extend the workflow path', async ({ page }) => {
  await anchorWorkflow(page, 'Customer');

  const frontierRail = page.locator('.workflow-rail-card', { hasText: 'Next frontier' });
  await frontierRail.getByRole('button', { name: 'Invoice' }).click();

  await expect(page.getByText('Invoice').first()).toBeVisible();
  await expect(page.locator('.workflow-active-record-label')).toHaveText('Invoice');
  await expect(page).toHaveURL(/levels=invoice/);
});

test('mobile shows the list fallback instead of a broken graph canvas', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  await anchorWorkflow(page, 'Customer');

  await expect(page.getByText('Desktop graph hidden below 768px')).toBeVisible();
  await expect(page.locator('.workflow-mobile-stage')).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);

  const frontierRail = page.locator('.workflow-rail-card', { hasText: 'Next frontier' });
  await frontierRail.getByRole('button', { name: 'Invoice' }).click();
  await expect(page.locator('.workflow-active-record-label')).toHaveText('Invoice');
});

test('inspector renders as a scrollable right-side drawer', async ({ page }) => {
  await anchorWorkflow(page, 'Customer');

  await page.getByRole('button', { name: 'Open inspector' }).click();

  const drawer = page.locator('.workflow-overlay-card');
  const scrollRegion = page.locator('.workflow-overlay-scroll');

  await expect(drawer).toBeVisible();
  await expect(scrollRegion).toBeVisible();

  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox.width).toBeLessThanOrEqual(490);

  const overflowY = await scrollRegion.evaluate((element) => getComputedStyle(element).overflowY);
  expect(overflowY).toBe('auto');
});

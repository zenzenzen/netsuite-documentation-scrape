const { test, expect } = require('playwright/test');

async function anchorWorkflow(page, recordSlug = 'customer', recordTitle = 'Customer') {
  await page.goto(`/workflow?base=${recordSlug}`);
  await expect(page.getByRole('heading', { name: new RegExp(`${recordTitle} transform atlas`, 'i') })).toBeVisible();
}

test('frontier pills extend the workflow path', async ({ page }) => {
  await anchorWorkflow(page, 'customer', 'Customer');

  const frontierRail = page.locator('.workflow-rail-card', { hasText: 'Next frontier' });
  await frontierRail.getByRole('button', { name: 'Invoice' }).click();

  await expect(page.getByText('Invoice').first()).toBeVisible();
  await expect(page.locator('.workflow-active-record-label')).toHaveText('Invoice');
  await expect(page).toHaveURL(/levels=invoice/);
});

test('mobile shows the list fallback instead of a broken graph canvas', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  await anchorWorkflow(page, 'customer', 'Customer');

  await expect(page.getByText('Desktop graph hidden below 768px')).toBeVisible();
  await expect(page.locator('.workflow-mobile-stage')).toBeVisible();
  await expect(page.locator('.react-flow')).toHaveCount(0);

  const frontierRail = page.locator('.workflow-rail-card', { hasText: 'Next frontier' });
  await frontierRail.getByRole('button', { name: 'Invoice' }).click();
  await expect(page.locator('.workflow-active-record-label')).toHaveText('Invoice');
});

test('query-string anchors a no-transform record without crashing the workflow page', async ({ page }) => {
  await page.goto('/workflow?base=units-type');

  await expect(page.getByRole('heading', { name: /Units Type transform atlas/i })).toBeVisible();
  await expect(page.locator('.workflow-active-record-label')).toHaveText('Units Type');
  await expect(
    page
      .locator('.workflow-rail-card')
      .filter({ has: page.getByRole('heading', { name: 'Next frontier' }) })
      .first()
  ).toContainText(
    'No further transforms from this selected node.'
  );
});

test('inspector renders as a scrollable right-side drawer', async ({ page }) => {
  await anchorWorkflow(page, 'customer', 'Customer');

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

test('workflow page shows an inline error state when a payload fetch fails', async ({ page }) => {
  await page.route('**/workflow-data/customer.json', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forced failure' }),
    })
  );

  await page.goto('/workflow?base=customer');

  await expect(page.locator('[data-workflow-error]')).toContainText('Workflow data unavailable for Customer.');
  await expect(page.getByRole('heading', { name: /Customer transform atlas/i })).toBeVisible();
});

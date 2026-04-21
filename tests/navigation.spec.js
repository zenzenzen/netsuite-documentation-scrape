const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('playwright/test');

const repoRoot = path.resolve(__dirname, '..');

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
  await expect(page.locator('a.record-link[href="/records/cash-sale"]').first()).toBeVisible();
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

test('workflow tree doc links stay in the same tab', async ({ page }) => {
  await page.goto('/records/customer');

  await page.getByRole('button', { name: /Open Cash Sale docs/i }).click();

  await expect(page).toHaveURL('/records/cash-sale');
  await expect(page.locator('h1', { hasText: 'Cash Sale' })).toBeVisible();
});

test('static build rewrites internal asset and data paths under the configured base path', async () => {
  execFileSync('npm', ['run', 'build', '--workspace', '@netsuite/docs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCS_BASE_PATH: '/docs',
    },
    stdio: 'pipe',
  });

  const recordHtml = fs.readFileSync(path.join(repoRoot, 'apps/docs/dist/records/customer/index.html'), 'utf8');
  const workflowHtml = fs.readFileSync(path.join(repoRoot, 'apps/docs/dist/workflow/index.html'), 'utf8');

  expect(recordHtml).toContain('href="/docs/app.css"');
  expect(recordHtml).toContain('src="/docs/app.js"');
  expect(recordHtml).toContain('"rootPrefix":"/docs/"');
  expect(recordHtml).toContain('"workflowConfigHref":"/docs/workflow-config.json"');
  expect(workflowHtml).toContain('basePath&quot;:[0,&quot;/docs/&quot;]');
});

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('playwright/test');

const recordsIndex = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'packages', 'netsuite-data', 'generated', 'records-index.json'), 'utf8')
);
const migratedRecords = recordsIndex.filter((record) => String(record.docsPath || '').startsWith('/records/'));

for (const record of migratedRecords) {
  test(`record route renders for ${record.slug}`, async ({ page }) => {
    await page.goto(record.docsPath);

    await expect(page.getByRole('heading', { level: 1, name: record.title })).toBeVisible();
    await expect(page.locator('[data-nav-panel] .nav-link').first()).toBeVisible();
    await expect(page.locator('#workflow-studio')).toBeVisible();
    await expect(page.locator('#netsuite-page-context')).toHaveCount(1);
    await expect(page.locator('#netsuite-workflow-config')).toHaveCount(0);

    expect(await page.locator('details.endpoint').count()).toBeGreaterThan(0);
  });
}

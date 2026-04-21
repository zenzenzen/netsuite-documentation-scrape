const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('playwright/test');

const recordsIndex = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'packages', 'netsuite-data', 'generated', 'records-index.json'), 'utf8')
);
const generatedRecordsRoot = path.resolve(__dirname, '..', 'packages', 'netsuite-data', 'generated', 'records');
const generatedPublicRecordsRoot = path.resolve(__dirname, '..', 'public', 'records');
const recordDetails = recordsIndex.map((record) =>
  JSON.parse(fs.readFileSync(path.join(generatedRecordsRoot, `${record.slug}.json`), 'utf8'))
);
const docsRecordNames = new Set(recordsIndex.map((record) => record.recordName));
const recordWithReferencedBy = recordDetails.find((record) => record.referencedBy?.length);
const recordWithUnindexedDependency = recordDetails.find((record) =>
  getAllDependencyNames(record).some((dependency) => !docsRecordNames.has(dependency))
);
const sampledRecords = Array.from(
  new Map(
    [recordsIndex[0], recordsIndex[Math.floor(recordsIndex.length / 2)], recordsIndex[recordsIndex.length - 1]]
      .filter(Boolean)
      .map((record) => [record.slug, record])
  ).values()
);

function getAllDependencyNames(record) {
  return Array.from(
    new Set([
      ...(record.dependencyRecords || []),
      ...(record.operations || []).flatMap((operation) => operation.dependencyRecords || []),
    ])
  );
}

test('every indexed record has a routed docsPath and generated artifacts', async () => {
  expect(recordsIndex.length).toBeGreaterThan(0);

  for (const record of recordsIndex) {
    expect(record.docsPath).toBe(`/records/${record.slug}`);
    expect(fs.existsSync(path.join(generatedRecordsRoot, `${record.slug}.json`))).toBeTruthy();
    expect(fs.existsSync(path.join(generatedPublicRecordsRoot, `${record.slug}.html`))).toBeTruthy();
  }
});

test('referencedBy metadata is internally consistent', async () => {
  for (const record of recordDetails) {
    for (const sourceRecordName of record.referencedBy || []) {
      const sourceRecord = recordDetails.find((candidate) => candidate.recordName === sourceRecordName);

      expect(sourceRecord, `${record.recordName} should only be referenced by indexed records`).toBeTruthy();
      expect(getAllDependencyNames(sourceRecord)).toContain(record.recordName);
    }
  }
});

for (const record of sampledRecords) {
  test(`record route renders for ${record.slug}`, async ({ page }) => {
    await page.goto(record.docsPath);

    await expect(page.getByRole('heading', { level: 1, name: record.title })).toBeVisible();
    await expect(page.locator('[data-nav-panel] .nav-link').first()).toBeVisible();
    await expect(page.locator('#workflow-studio')).toBeVisible();
    await expect(page.locator('#netsuite-page-context')).toHaveCount(1);
    await expect(page.locator('#netsuite-workflow-config')).toHaveCount(0);
    await expect(page.locator('[data-record-links-panel]')).toBeVisible();
    await expect(page.locator('[data-record-referenced-by-panel]')).toBeVisible();

    expect(await page.locator('details.endpoint').count()).toBeGreaterThan(0);
  });
}

if (recordWithReferencedBy) {
  test('record page renders referencedBy chips', async ({ page }) => {
    await page.goto(recordWithReferencedBy.docsPath);
    await expect(page.locator('[data-record-referenced-by-panel] [data-doc-link-state]')).toHaveCount(
      recordWithReferencedBy.referencedBy.length
    );
  });
} else {
  test.skip('record page renders referencedBy chips', async () => {});
}

if (recordWithUnindexedDependency) {
  test('record page renders disabled chips for out-of-index dependencies', async ({ page }) => {
    const missingDependency = getAllDependencyNames(recordWithUnindexedDependency).find(
      (dependency) => !docsRecordNames.has(dependency)
    );

    await page.goto(recordWithUnindexedDependency.docsPath);

    const disabledChip = page
      .locator('[data-doc-link-state="disabled"]')
      .filter({ hasText: missingDependency })
      .first();

    await expect(disabledChip).toBeVisible();
    await expect(disabledChip).toHaveAttribute('aria-disabled', 'true');
    await expect(disabledChip).toHaveAttribute('title', new RegExp(missingDependency));
  });
} else {
  test.skip('record page renders disabled chips for out-of-index dependencies', async () => {});
}

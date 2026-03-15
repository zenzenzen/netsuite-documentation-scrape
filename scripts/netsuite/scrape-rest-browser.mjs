import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  AUTH_DIR,
  DATA_ROOT,
  DEFAULT_DOCS_URL,
  FOCUS_RECORDS,
  RAW_RECORDS_DIR,
  RAW_ROOT,
  STORAGE_STATE_PATH,
  ensureDir,
  getRuntimeEnv,
  resolveRecordName,
  unique,
  writeJson,
} from './shared.mjs';

const env = getRuntimeEnv();

const docsUrl = env.NETSUITE_DOCS_URL || DEFAULT_DOCS_URL;
const headless = env.HEADLESS !== 'false';
const allowManualMfa = env.NETSUITE_ALLOW_MANUAL_MFA === 'true';
const scrapeAll = env.NETSUITE_SCRAPE_ALL !== 'false';

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors.filter(Boolean)) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) {
          return locator;
        }
      } catch {
        // The DOM can re-render between selector probes. Ignore and keep trying.
      }
    }
  }

  return null;
}

async function fillFirstVisible(page, selectors, value) {
  if (!value) {
    return false;
  }

  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) {
    return false;
  }

  await locator.fill(value);
  return true;
}

async function clickFirstVisible(page, selectors) {
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) {
    return false;
  }

  await locator.click();
  return true;
}

async function docsLoaded(page) {
  return (await page.locator('body#spectacle article').count()) > 0;
}

async function waitForDocs(page, timeout = 120000) {
  await page.waitForSelector('body#spectacle article', { timeout });
}

async function loginIfNeeded(page) {
  if (await docsLoaded(page)) {
    return false;
  }

  const email = env.NETSUITE_EMAIL;
  const password = env.NETSUITE_PASSWORD;
  const accountId = env.NETSUITE_ACCOUNT_ID;

  if (!email || !password) {
    throw new Error(
      'NetSuite docs are not directly available and no credentials were provided. Set NETSUITE_EMAIL and NETSUITE_PASSWORD in .env.'
    );
  }

  await fillFirstVisible(page, [
    env.NETSUITE_USERNAME_SELECTOR,
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="userName"]',
    'input[autocomplete="username"]',
    '#email',
    '#username',
  ], email);

  await clickFirstVisible(page, [
    env.NETSUITE_NEXT_SELECTOR,
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'input[type="submit"]',
  ]);

  await page.waitForTimeout(500);

  await fillFirstVisible(page, [
    env.NETSUITE_PASSWORD_SELECTOR,
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    '#password',
  ], password);

  await fillFirstVisible(page, [
    env.NETSUITE_ACCOUNT_SELECTOR,
    'input[name="account"]',
    'input[name="accountId"]',
    'input[placeholder*="Account"]',
  ], accountId);

  await clickFirstVisible(page, [
    env.NETSUITE_SUBMIT_SELECTOR,
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Submit")',
    'input[type="submit"]',
  ]);

  try {
    await waitForDocs(page, 20000);
    return true;
  } catch {
    if (!allowManualMfa) {
      throw new Error(
        'Login did not complete automatically. If your NetSuite tenant requires MFA, rerun with HEADLESS=false and NETSUITE_ALLOW_MANUAL_MFA=true.'
      );
    }

    if (headless) {
      throw new Error(
        'Manual MFA was enabled, but HEADLESS is still true. Set HEADLESS=false so you can finish the challenge in the browser window.'
      );
    }

    console.log('Waiting for manual MFA completion in the browser window...');
    await waitForDocs(page, 300000);
    return true;
  }
}

function recordFilePath(recordName) {
  return path.join(RAW_RECORDS_DIR, `${recordName}.json`);
}

async function collectAvailableRecords(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[id^="tag-"]')).map((el) =>
      el.id.replace(/^tag-/, '')
    )
  );
}

async function extractRecord(page, recordName, availableRecords) {
  return page.evaluate(
    ({ recordName, availableRecords }) => {
      const availableSet = new Set(availableRecords);

      const clean = (value) =>
        String(value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();

      const uniqueBy = (items, keyFn) => {
        const seen = new Set();
        const result = [];

        for (const item of items) {
          const key = keyFn(item);
          if (!key || seen.has(key)) {
            continue;
          }

          seen.add(key);
          result.push(item);
        }

        return result;
      };

      const getOwnText = (element) => {
        if (!element) {
          return '';
        }

        const clone = element.cloneNode(true);
        clone.querySelectorAll('.prop-row').forEach((row) => row.remove());
        return clean(clone.textContent);
      };

      const directPropRows = (element) =>
        Array.from(element?.children || []).filter((child) =>
          child.classList?.contains('prop-row')
        );

      const parseRefs = (scope) =>
        uniqueBy(
          Array.from(scope?.querySelectorAll('a.json-schema-ref, .prop-ref a') || []).map((link) => ({
            text: clean(link.textContent),
            href: link.getAttribute('href') || '',
            definitionId: (link.getAttribute('href') || '').replace(/^#\/definitions\//, ''),
          })),
          (item) => `${item.text}|${item.href}`
        );

      const parsePropRow = (row) => {
        const nameElement = row.querySelector(':scope > .prop-name') || row.querySelector('.prop-name');
        const valueElement = row.querySelector(':scope > .prop-value') || row.querySelector('.prop-value');
        const refs = parseRefs(row);
        const children = directPropRows(valueElement).map(parsePropRow);
        const nameText = getOwnText(nameElement);
        const description = getOwnText(valueElement);
        const enumValues = Array.from(
          nameElement?.querySelectorAll('.json-property-enum-item') || []
        ).map((item) => clean(item.textContent));

        return {
          label:
            clean(nameElement?.querySelector('.prop-title')?.textContent) ||
            refs[0]?.text ||
            nameText.split('\n')[0] ||
            '',
          name: nameText,
          description,
          type: clean(
            [
              nameElement?.querySelector('.prop-type')?.textContent,
              nameElement?.querySelector('.json-property-type')?.textContent,
              nameElement?.querySelector('.json-property-format')?.textContent,
              nameElement?.querySelector('.json-property-range')?.textContent,
            ]
              .filter(Boolean)
              .join(' ')
          ),
          subtitle: clean(nameElement?.querySelector('.prop-subtitle')?.textContent),
          required: Boolean(nameElement?.querySelector('.json-property-required')),
          defaultValue: clean(valueElement?.querySelector('.json-property-default-value')?.textContent),
          enumValues,
          refs,
          children,
        };
      };

      const parseSectionRows = (element) => directPropRows(element).map(parsePropRow);

      const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const opRegex = new RegExp(`^operation--${escapeRegex(recordName)}(?:-|--)`);

      const tagElement = document.getElementById(`tag-${recordName}`);
      const definitionElement = document.getElementById(`definition-${recordName}`);
      const operationElements = Array.from(document.querySelectorAll('[id^="operation--"]')).filter((el) =>
        opRegex.test(el.id)
      );

      const operations = operationElements.map((operationElement) => {
        const method = clean(operationElement.querySelector('.operation-method')?.textContent);
        const path = clean(operationElement.querySelector('.operation-path')?.textContent);
        const requestBody = parseSectionRows(
          operationElement.querySelector('.swagger-request-body')
        );
        const parameters = parseSectionRows(
          operationElement.querySelector('.swagger-request-params')
        );
        const responses = parseSectionRows(
          operationElement.querySelector('.swagger-responses')
        );
        const dependencyRefs = uniqueBy(
          [...requestBody, ...parameters, ...responses]
            .flatMap((row) => [row, ...(row.children || [])])
            .flatMap((row) => row.refs || []),
          (item) => `${item.text}|${item.href}`
        );
        const transformTarget = path.includes('/!transform/')
          ? path.split('/!transform/')[1]
          : null;
        const dependencyRecords = Array.from(
          new Set(
            dependencyRefs
              .map((ref) => ref.definitionId || ref.text)
              .filter((name) => availableSet.has(name))
          )
        );

        if (transformTarget && availableSet.has(transformTarget)) {
          dependencyRecords.push(transformTarget);
        }

        return {
          id: operationElement.id,
          summary: clean(operationElement.querySelector('.operation-title')?.textContent),
          tag: clean(operationElement.querySelector('.operation-tags .label')?.textContent),
          method,
          path,
          isTransform: Boolean(transformTarget),
          transformTarget,
          requestBody,
          parameters,
          responses,
          dependencyRefs,
          dependencyRecords: Array.from(new Set(dependencyRecords)),
          rawText: clean(operationElement.innerText),
        };
      });

      const schemaFields = parseSectionRows(definitionElement);
      const schemaRefs = parseRefs(definitionElement);
      const schemaDependencyRecords = Array.from(
        new Set(
          schemaRefs
            .map((ref) => ref.definitionId || ref.text)
            .filter((name) => availableSet.has(name))
        )
      );

      const transforms = operations
        .filter((operation) => operation.isTransform)
        .map((operation) => ({
          id: operation.id,
          source: recordName,
          target: operation.transformTarget,
          method: operation.method,
          path: operation.path,
          summary: operation.summary,
          dependencyRecords: operation.dependencyRecords,
          dependencyRefs: operation.dependencyRefs,
        }));

      const dependencyRecords = Array.from(
        new Set([
          ...operations.flatMap((operation) => operation.dependencyRecords),
          ...schemaDependencyRecords,
        ])
      ).filter((name) => name !== recordName);

      return {
        recordName,
        title: clean(tagElement?.textContent) || recordName,
        stats: {
          operations: operations.length,
          transforms: transforms.length,
          schemaFields: schemaFields.length,
        },
        operations,
        transforms,
        definition: {
          id: `definition-${recordName}`,
          refs: schemaRefs,
          fields: schemaFields,
          rawText: clean(definitionElement?.innerText),
        },
        dependencyRecords,
      };
    },
    { recordName, availableRecords }
  );
}

async function main() {
  ensureDir(DATA_ROOT);
  ensureDir(RAW_ROOT);
  ensureDir(RAW_RECORDS_DIR);
  ensureDir(AUTH_DIR);

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 80,
  });

  try {
    const context = await browser.newContext(
      fs.existsSync(STORAGE_STATE_PATH) ? { storageState: STORAGE_STATE_PATH } : {}
    );
    const page = await context.newPage();

    console.log(`Opening NetSuite docs: ${docsUrl}`);
    await page.goto(docsUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});

    const usedLogin = await loginIfNeeded(page);
    await waitForDocs(page);

    if (usedLogin) {
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log(`Saved authenticated browser state to ${STORAGE_STATE_PATH}`);
    }

    const availableRecords = await collectAvailableRecords(page);
    const scopeRecords = scrapeAll
      ? availableRecords
      : FOCUS_RECORDS.map((name) => resolveRecordName(name)).filter((name) =>
          availableRecords.includes(name)
        );

    console.log(`Scraping ${scopeRecords.length} records from the REST API browser...`);

    for (const recordName of scopeRecords) {
      const record = await extractRecord(page, recordName, availableRecords);
      writeJson(recordFilePath(recordName), record);
      console.log(`  wrote ${recordName}`);
    }

    writeJson(path.join(RAW_ROOT, 'index.json'), {
      sourceUrl: docsUrl,
      scrapedAt: new Date().toISOString(),
      scrapeScope: scrapeAll ? 'all' : 'focus',
      focusRecords: FOCUS_RECORDS,
      availableRecords,
      scrapedRecords: scopeRecords,
    });

    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

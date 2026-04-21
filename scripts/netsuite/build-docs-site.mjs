import fs from 'node:fs';
import path from 'node:path';
import {
  BILLING_RECORDS,
  FOCUS_RECORDS,
  GENERATED_DATA_DIR,
  GENERATED_RECORDS_DIR,
  GENERATED_WORKFLOWS_DIR,
  PROJECT_ROOT,
  PUBLIC_DIR,
  PUBLIC_HOME_FILE,
  PUBLIC_RECORDS_DIR,
  PUBLIC_TRANSFORMS_FILE,
  RAW_RECORDS_DIR,
  RAW_ROOT,
  compact,
  ensureDir,
  methodTone,
  readJson,
  relativeLinkFromRecord,
  relativeLinkFromRoot,
  slugify,
  toTitleCase,
  unique,
  writeJson,
  writeText,
} from './shared.mjs';
import { buildLayeredWorkflow, enrichRecordCategory } from '../../packages/workflow-core/src/index.js';

const rawIndex = readJson(path.join(RAW_ROOT, 'index.json'));

if (!rawIndex) {
  throw new Error('Missing scraped NetSuite data. Run `npm run netsuite:scrape` first.');
}

function loadRecords(recordNames) {
  return recordNames
    .map((recordName) => readJson(path.join(RAW_RECORDS_DIR, `${recordName}.json`)))
    .filter(Boolean);
}

const allRecords = loadRecords(rawIndex.scrapedRecords);
const recordMap = new Map(allRecords.map((record) => [record.recordName, record]));
const allRecordSet = new Set(allRecords.map((record) => record.recordName));

function getLinkedRecordNames(record) {
  return unique([
    ...(record.dependencyRecords || []),
    ...((record.operations || []).flatMap((operation) => operation.dependencyRecords || [])),
  ]);
}

function buildReferencedByMap(records) {
  const referencedBy = new Map();

  // Invert the dependency graph once during the build so record pages can show back-links cheaply.
  for (const record of records) {
    for (const dependency of getLinkedRecordNames(record)) {
      if (!allRecordSet.has(dependency)) {
        continue;
      }

      if (!referencedBy.has(dependency)) {
        referencedBy.set(dependency, new Set());
      }

      referencedBy.get(dependency).add(record.recordName);
    }
  }

  return referencedBy;
}

function buildUnresolvedReferenceMap(records) {
  const unresolved = new Map();

  for (const record of records) {
    for (const dependency of getLinkedRecordNames(record)) {
      if (allRecordSet.has(dependency)) {
        continue;
      }

      if (!unresolved.has(record.recordName)) {
        unresolved.set(record.recordName, new Set());
      }

      unresolved.get(record.recordName).add(dependency);
    }
  }

  return unresolved;
}

const referencedByMap = buildReferencedByMap(allRecords);
const unresolvedReferenceMap = buildUnresolvedReferenceMap(allRecords);
const focusRecords = FOCUS_RECORDS.map((name) => recordMap.get(name)).filter(Boolean);
const billingRecords = BILLING_RECORDS.map((name) => recordMap.get(name)).filter(Boolean);
const billingRecordSet = new Set(billingRecords.map((record) => record.recordName));
const focusDependencyRecords = unique(
  focusRecords.flatMap((record) => getLinkedRecordNames(record))
).filter((recordName) => !FOCUS_RECORDS.includes(recordName) && !billingRecordSet.has(recordName));
const dependencyRecords = focusDependencyRecords
  .map((recordName) => recordMap.get(recordName))
  .filter(Boolean)
  .slice(0, 30);
const curatedRecords = unique([...focusRecords, ...dependencyRecords, ...billingRecords]);
const curatedRecordSet = new Set(curatedRecords.map((record) => record.recordName));

const allTransforms = allRecords.flatMap((record) => record.transforms || []);
const focusTransforms = allTransforms.filter(
  (transform) =>
    FOCUS_RECORDS.includes(transform.source) || FOCUS_RECORDS.includes(transform.target)
);
const WORKFLOW_CONFIG_FILE = path.join(PROJECT_ROOT, 'workflow-map.json');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function summarizeRecord(record) {
  const firstOperationSummary = (record.operations || []).find((operation) => operation.summary)?.summary;
  const transformSummary = record.transforms?.length
    ? `${record.transforms.length} transform workflow${record.transforms.length === 1 ? '' : 's'} available.`
    : '';
  const dependencySummary = record.dependencyRecords?.length
    ? `${record.dependencyRecords.length} linked dependency record${record.dependencyRecords.length === 1 ? '' : 's'}.`
    : '';

  return (
    compact([firstOperationSummary, transformSummary, dependencySummary]).join(' ') ||
    'Generated from the NetSuite REST API Browser scrape.'
  );
}

function buildRecordDocsPath(recordName) {
  return `/records/${slugify(recordName)}`;
}

function buildWorkflowConfig(records, transforms) {
  const focusSet = new Set(FOCUS_RECORDS);
  const billingSet = new Set(BILLING_RECORDS);
  const dependencySet = new Set(dependencyRecords.map((record) => record.recordName));

  const transformEntries = transforms.map((transform, index) => ({
    id: `${slugify(transform.source)}--${slugify(transform.target)}--${index + 1}`,
    source: transform.source,
    sourceSlug: slugify(transform.source),
    target: transform.target,
    targetSlug: slugify(transform.target),
    method: transform.method,
    path: transform.path,
    summary: transform.summary || `Transform ${transform.source} to ${transform.target}.`,
  }));

  const outgoingCounts = new Map();
  const incomingCounts = new Map();

  for (const transform of transformEntries) {
    outgoingCounts.set(transform.source, (outgoingCounts.get(transform.source) || 0) + 1);
    incomingCounts.set(transform.target, (incomingCounts.get(transform.target) || 0) + 1);
  }

  const recordEntries = records
    .map((record) => ({
      recordName: record.recordName,
      slug: slugify(record.recordName),
      title: toTitleCase(record.recordName),
      group: focusSet.has(record.recordName)
        ? 'focus'
        : billingSet.has(record.recordName)
          ? 'billing'
        : dependencySet.has(record.recordName)
          ? 'dependency'
          : 'extended',
      summary: summarizeRecord(record),
      docsPath: buildRecordDocsPath(record.recordName),
      stats: {
        operations: record.stats?.operations || 0,
        transforms: record.stats?.transforms || 0,
        schemaFields: record.stats?.schemaFields || 0,
        outgoingTransforms: outgoingCounts.get(record.recordName) || 0,
        incomingTransforms: incomingCounts.get(record.recordName) || 0,
      },
      dependencies: getLinkedRecordNames(record),
      endpoints: (record.operations || []).slice(0, 12).map((operation) => ({
        method: operation.method,
        path: operation.path,
        summary: operation.summary || 'Operation',
        isTransform: Boolean(operation.isTransform),
      })),
    }))
    .sort((left, right) => {
      const weight = { focus: 0, billing: 1, dependency: 2, extended: 3 };
      return weight[left.group] - weight[right.group] || left.title.localeCompare(right.title);
    });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceUrl: rawIndex.sourceUrl,
    records: recordEntries,
    transforms: transformEntries,
  };
}

const workflowConfig = buildWorkflowConfig(allRecords, allTransforms);
const generatedRecordsIndex = workflowConfig.records.map((record) => enrichRecordCategory(record));
// Every routed record should be a valid workflow anchor, even if it has no outgoing transforms.
const generatedWorkflowIndex = generatedRecordsIndex.map((record) => ({
  recordName: record.recordName,
  slug: record.slug,
  title: record.title,
  category: record.category,
  categoryLabel: record.categoryLabel,
  outgoingTransforms: record.stats.outgoingTransforms,
}));

function buildWorkflowLayouts() {
  return generatedWorkflowIndex.map((record) => {
    const layered = buildLayeredWorkflow(generatedRecordsIndex, workflowConfig.transforms, record.recordName);

    return {
      slug: record.slug,
      ...layered,
    };
  });
}

const generatedWorkflowLayouts = buildWorkflowLayouts();

function buildRecordDetail(record) {
  return {
    recordName: record.recordName,
    slug: slugify(record.recordName),
    title: toTitleCase(record.recordName),
    summary: summarizeRecord(record),
    docsPath: buildRecordDocsPath(record.recordName),
    stats: record.stats || {
      operations: 0,
      transforms: 0,
      schemaFields: 0,
    },
    dependencyRecords: getLinkedRecordNames(record),
    referencedBy: Array.from(referencedByMap.get(record.recordName) || []).sort(),
    operations: record.operations || [],
    definition: {
      ...(record.definition || {}),
      fields: (record.definition?.fields || []).slice(0, 40),
    },
  };
}

function renderLinkedChip(label, description, href, disabledTitle) {
  if (href) {
    return `<a class="chip" href="${escapeHtml(href)}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(
      description
    )}</small></a>`;
  }

  return `<span class="chip chip-disabled" aria-disabled="true" title="${escapeHtml(
    disabledTitle
  )}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>`;
}

function buildLegacyRecordLink(recordName) {
  return allRecordSet.has(recordName) ? relativeLinkFromRecord(recordName) : null;
}

function renderPinnedSection() {
  return `
    <details
      class="tool-panel pinned-panel page-section"
      data-favorites-panel
      data-page-section
      data-section-id="pinned-objects"
      data-section-title="Pinned Objects"
      open
    >
      <summary>
        <span>Pinned Objects</span>
        <span class="panel-meta" data-favorites-count>0 pinned</span>
      </summary>
      <div class="tool-panel-body">
        <p class="muted">Pin records from cards, record pages, or the workflow studio to keep a reusable shortlist close by.</p>
        <div class="favorites-grid" data-favorites-list></div>
      </div>
    </details>
  `;
}

function renderWorkflowStudioSection(defaultBaseRecord) {
  return `
    <section
      class="workflow-studio page-section"
      id="workflow-studio"
      data-workflow-studio
      data-page-section
      data-section-id="workflow-studio"
      data-section-title="Workflow Studio"
      data-default-base="${escapeHtml(
      defaultBaseRecord
    )}"
    >
      <div class="section-heading workflow-heading">
        <h2>Workflow Studio</h2>
        <p>Start from a base object, preview the next transform fan-out at 50% opacity, then lock branches forward. The active query below shows the GET route for the current base object.</p>
      </div>
      <div class="workflow-shell">
      <div class="workflow-toolbar">
        <label class="workflow-label">
          <span>Base object</span>
          <select class="workflow-select" data-workflow-base></select>
        </label>
        <div class="workflow-toolbar-actions">
          <button class="record-link secondary workflow-action" type="button" data-workflow-commit>Lock selected objects</button>
          <button class="record-link secondary workflow-action" type="button" data-workflow-back>Step back one level</button>
          <button class="record-link secondary workflow-action" type="button" data-workflow-reset>Reset to base</button>
        </div>
      </div>

        <div class="workflow-legend">
          <span class="workflow-dot workflow-dot-locked"></span> locked branch
          <span class="workflow-dot workflow-dot-preview"></span> preview branch
          <span class="workflow-dot workflow-dot-selected"></span> queued for lock
        </div>

        <div class="workflow-canvas" data-workflow-tree></div>

        <div class="workflow-output-grid">
          <section class="tool-panel workflow-output">
            <summary class="static-summary">Postman active query</summary>
            <div class="tool-panel-body">
              <div class="workflow-copy-row">
                <button class="record-link secondary workflow-action" type="button" data-copy-share-query>Copy share query</button>
              </div>
              <pre class="workflow-code" data-share-query></pre>
              <pre class="workflow-code" data-active-query></pre>
              <p class="muted">GET requests do not require request body data.</p>
              <p class="workflow-query-note" data-active-query-note></p>
            </div>
          </section>

          <section class="tool-panel workflow-output">
            <summary class="static-summary">Atomic workflow config</summary>
            <div class="tool-panel-body">
              <p class="muted">This lightweight JSON shape is the browser-safe config that can later move into a database or Atlas-backed service.</p>
              <pre class="workflow-code" data-workflow-config-output></pre>
            </div>
          </section>
        </div>
      </div>
    </section>
  `;
}

function pageShell({
  title,
  eyebrow,
  intro,
  body,
  extraHead = '',
  script = '',
  faviconHref = './favicon.svg',
  rootPrefix = './',
  pageKind = 'overview',
  currentRecordName = '',
  defaultBaseRecord = 'salesOrder',
  homeHref = './public.html',
  transformsHref = './transforms.html',
}) {
  const pageContext = {
    pageKind,
    currentRecordName,
    defaultBaseRecord,
    rootPrefix,
    homeHref,
    transformsHref,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${escapeHtml(faviconHref)}">
  <link rel="stylesheet" href="${escapeHtml(rootPrefix)}app.css">
  ${extraHead}
</head>
<body data-page-kind="${escapeHtml(pageKind)}" data-current-record="${escapeHtml(
    currentRecordName
  )}">
  <aside class="nav-panel" data-nav-panel aria-label="NetSuite object navigation"></aside>
  <div class="shell">
    <div class="hero">
      <div class="hero-card">
        <div class="eyebrow">${escapeHtml(eyebrow)}</div>
        <h1>${escapeHtml(title)}</h1>
        <div class="intro">${intro}</div>
        <div class="top-nav">
          <a class="top-link" href="${escapeHtml(homeHref)}"><strong>Overview</strong> <span>Focus objects</span></a>
          <a class="top-link" href="${escapeHtml(transformsHref)}"><strong>Transforms</strong> <span>Workflow map</span></a>
        </div>
      </div>
    </div>
    <main class="page-body" data-page-body>
      ${renderPinnedSection()}
      ${body}
      ${renderWorkflowStudioSection(defaultBaseRecord)}
    </main>
  </div>
  <script id="netsuite-page-context" type="application/json">${serializeJsonForHtml(pageContext)}</script>
  <script id="netsuite-workflow-config" type="application/json">${serializeJsonForHtml(
    workflowConfig
  )}</script>
  ${script}
  <script type="module" src="${escapeHtml(rootPrefix)}app.js"></script>
</body>
</html>`;
}

function renderDependencyChips(record, linkBuilder) {
  const dependencies = record.dependencyRecords || [];

  if (!dependencies.length) {
    return '<div class="muted">No linked record dependencies were detected in the scraped schema and operations.</div>';
  }

  return `<div class="chip-row">${dependencies
    .map(
      (dependency) =>
        renderLinkedChip(
          dependency,
          toTitleCase(dependency),
          linkBuilder(dependency),
          `No page generated for ${dependency}.`
        )
    )
    .join('')}</div>`;
}

function renderReferencedByChips(record, linkBuilder) {
  const referencedBy = record.referencedBy || [];

  if (!referencedBy.length) {
    return '<div class="muted">No other indexed records currently point at this record.</div>';
  }

  return `<div class="chip-row">${referencedBy
    .map((recordName) =>
      renderLinkedChip(
        recordName,
        'references this record',
        linkBuilder(recordName),
        `No page generated for ${recordName}.`
      )
    )
    .join('')}</div>`;
}

function renderEndpointDetails(operation, linkBuilder) {
  const paramRows = operation.parameters || [];
  const bodyRows = operation.requestBody || [];
  const responseRows = operation.responses || [];
  const dependencies = operation.dependencyRecords || [];

  return `<details class="endpoint" ${operation.isTransform ? 'open' : ''}>
    <summary>
      <div class="endpoint-top">
        <span class="method-badge ${methodTone(operation.method)}">${escapeHtml(operation.method)}</span>
        ${operation.isTransform ? '<span class="pill">Transform route</span>' : ''}
        <span class="endpoint-path">${escapeHtml(operation.path)}</span>
      </div>
      <div class="endpoint-summary">${escapeHtml(operation.summary || 'Operation')}</div>
      ${
        dependencies.length
          ? `<div class="chip-row">${dependencies
              .map(
                (dependency) =>
                  renderLinkedChip(
                    dependency,
                    'dependency',
                    linkBuilder(dependency),
                    `No page generated for ${dependency}.`
                  )
              )
              .join('')}</div>`
          : ''
      }
    </summary>
    <div class="endpoint-body">
      <div class="split">
        <div class="subpanel">
          <h4>Request Parameters</h4>
          ${
            paramRows.length
              ? `<ul>${paramRows
                  .map(
                    (row) =>
                      `<li><strong>${escapeHtml(row.label)}</strong>${row.type ? ` <span class="mono">${escapeHtml(row.type)}</span>` : ''}<br>${escapeHtml(
                        row.description || 'No parameter description captured.'
                      )}</li>`
                  )
                  .join('')}</ul>`
              : '<div class="muted">No explicit parameter rows were found for this endpoint.</div>'
          }
        </div>
        <div class="subpanel">
          <h4>Request / Response Schemas</h4>
          <ul>
            ${bodyRows.length
              ? bodyRows
                  .map(
                    (row) =>
                      `<li><strong>${escapeHtml(row.label)}</strong>${row.refs?.length ? ` <span class="mono">${escapeHtml(row.refs.map((ref) => ref.text).join(', '))}</span>` : ''}<br>${escapeHtml(
                        row.description || 'Request body row.'
                      )}</li>`
                  )
                  .join('')
              : '<li>No request body rows detected.</li>'}
            ${responseRows.length
              ? responseRows
                  .slice(0, 5)
                  .map(
                    (row) =>
                      `<li><strong>${escapeHtml(row.label)}</strong>${row.refs?.length ? ` <span class="mono">${escapeHtml(row.refs.map((ref) => ref.text).join(', '))}</span>` : ''}<br>${escapeHtml(
                        row.description || 'Response row.'
                      )}</li>`
                  )
                  .join('')
              : '<li>No response rows detected.</li>'}
          </ul>
        </div>
      </div>
    </div>
  </details>`;
}

function renderSchemaTable(record) {
  const rows = (record.definition?.fields || []).slice(0, 40);

  if (!rows.length) {
    return '<div class="muted">No schema field rows were captured for this record definition.</div>';
  }

  return `<table class="schema-table">
    <thead>
      <tr>
        <th>Field</th>
        <th>Type</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) => `<tr>
            <td><code>${escapeHtml(row.label || row.name)}</code></td>
            <td>${escapeHtml(row.type || '-')}</td>
            <td>${escapeHtml(row.description || row.subtitle || 'No description captured.')}</td>
          </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function renderRecordPage(record) {
  const operationMarkup = (record.operations || [])
    .map((operation) => renderEndpointDetails(operation, buildLegacyRecordLink))
    .join('');

  return pageShell({
    title: `${record.recordName} | NetSuite REST API`,
    eyebrow: 'NetSuite Record Explorer',
    faviconHref: '../../favicon.svg',
    rootPrefix: '../../',
    pageKind: 'record',
    currentRecordName: record.recordName,
    defaultBaseRecord: record.recordName,
    homeHref: '../../public.html',
    transformsHref: '../../transforms.html',
    intro: `<div class="record-meta">
      <span class="pill">${record.stats.operations} endpoints</span>
      <span class="pill">${record.stats.transforms} transforms</span>
      <span class="pill">${record.stats.schemaFields} schema rows</span>
    </div>
    <div class="muted">This page is generated from the NetSuite REST API Browser scrape and tuned for fast scanning: endpoint cards, transform emphasis, and direct links to dependency records.</div>
    <div class="record-actions hero-actions">
      <button class="record-link secondary favorite-toggle" type="button" data-favorite-toggle data-record-name="${escapeHtml(
        record.recordName
      )}">Pin favorite</button>
      <a class="record-link secondary" href="#workflow-studio">Open in workflow studio</a>
    </div>`,
    body: `
      <section class="page-section" data-page-section data-section-id="record-links" data-section-title="${escapeHtml(
        toTitleCase(record.recordName)
      )}">
        <div class="section-heading">
          <h2>${escapeHtml(toTitleCase(record.recordName))}</h2>
          <p>Linked records surface here as navigable chips, so you can jump between record dependencies while you read the endpoint contracts.</p>
        </div>
        <div class="panel">
          ${renderDependencyChips(record, buildLegacyRecordLink)}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="record-referenced-by" data-section-title="Referenced By">
        <div class="section-heading">
          <h2>Referenced By</h2>
          <p>Use these back-links to find the indexed records that currently point at this record through schema or endpoint dependency references.</p>
        </div>
        <div class="panel">
          ${renderReferencedByChips(record, buildLegacyRecordLink)}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="record-endpoints" data-section-title="Endpoints">
        <div class="section-heading">
          <h2>Endpoints</h2>
          <p>Transform routes are expanded by default because they usually drive the interesting cross-record workflows in NetSuite.</p>
        </div>
        <div class="accordion">
          ${operationMarkup}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="record-schema" data-section-title="Schema Snapshot" id="schema">
        <div class="section-heading">
          <h2>Schema Snapshot</h2>
          <p>The definition table highlights the first 40 captured rows from the record schema, which is usually enough to orient yourself before dropping into the raw JSON.</p>
        </div>
        <div class="panel">
          ${renderSchemaTable(record)}
        </div>
      </section>
    `,
  });
}

function renderOverviewPage() {
  const stats = {
    focusRecords: focusRecords.length,
    dependencyRecords: dependencyRecords.length,
    transforms: focusTransforms.length,
    totalScraped: rawIndex.scrapedRecords.length,
  };
  const billingCardMeta = [
    {
      recordName: 'customer',
      kicker: 'Relationship anchor',
      summary:
        'Owns the commercial relationship and exposes billing schedule plus subscription-related sublists that feed the recurring billing setup path.',
    },
    {
      recordName: 'billingSchedule',
      kicker: 'Cadence definition',
      summary:
        'Defines first-bill behavior, recurrence frequency, repeat interval, and arrears vs advance billing for recurring charges.',
    },
    {
      recordName: 'billingAccount',
      kicker: 'Customer billing context',
      summary:
        'Binds the customer, billing schedule, currency, and billing start date into the account that the subscription will actually bill through.',
    },
    {
      recordName: 'subscriptionPlan',
      kicker: 'Default template',
      summary:
        'Carries the default line, renewal, and uplift behavior that draft subscriptions inherit before any customer-specific edits.',
    },
    {
      recordName: 'subscriptionTerm',
      kicker: 'Duration model',
      summary:
        'Defines the term type, unit, and duration that shape the subscription lifecycle and renewal defaults.',
    },
    {
      recordName: 'subscription',
      kicker: 'Recurring contract',
      summary:
        'The main draft/create surface for the recurring contract, connecting customer, billing account, plan, price book, and term.',
    },
    {
      recordName: 'subscriptionLine',
      kicker: 'Line-level behavior',
      summary:
        'Controls renewal inclusion, proration, billing mode, and line activation details after the subscription shell exists.',
    },
    {
      recordName: 'subscriptionChangeOrder',
      kicker: 'Lifecycle changes',
      summary:
        'Handles renew, modify pricing, suspend, reactivate, and terminate workflows after the base subscription is already in play.',
    },
    {
      recordName: 'billingRevenueEvent',
      kicker: 'Downstream event',
      summary:
        'Represents downstream billing or revenue activity tied to subscription lines rather than the initial recurring contract setup itself.',
    },
  ];
  const recurringAmountFieldCards = [
    {
      recordName: 'estimate',
      field: 'recurMonthly',
      title: 'Estimate.recurMonthly',
      summary:
        'A sales-pipeline recurring amount signal on an estimate. Useful for forecasting and quoting context, but not the primary SuiteBilling setup endpoint.',
    },
    {
      recordName: 'opportunity',
      field: 'recurMonthly',
      title: 'Opportunity.recurMonthly',
      summary:
        'A recurring revenue hint on the opportunity record. It helps frame monthly value during pipeline work, but the actual recurring billing setup happens on SuiteBilling records.',
    },
  ];

  const focusCards = focusRecords
    .map(
      (record) => `<article class="record-card">
        <div class="kicker">Focus object</div>
        <h3>${escapeHtml(toTitleCase(record.recordName))}</h3>
        <div class="record-meta">
          <span class="pill">${record.stats.operations} endpoints</span>
          <span class="pill">${record.stats.transforms} transforms</span>
          <span class="pill">${record.stats.schemaFields} schema rows</span>
        </div>
        <div class="record-copy">${escapeHtml(
          compact([
            record.transforms?.length
              ? `${record.transforms.length} transform workflow${record.transforms.length === 1 ? '' : 's'} detected.`
              : 'No transform workflows were captured.',
            record.dependencyRecords?.length
              ? `${record.dependencyRecords.length} linked dependency records.`
              : 'No cross-record dependencies detected.',
          ]).join(' ')
        )}</div>
        <div class="chip-row" style="margin-top:12px;">
          ${(record.transforms || [])
            .slice(0, 4)
            .map(
              (transform) =>
                `<span class="chip"><strong>${escapeHtml(record.recordName)}</strong><small>to ${escapeHtml(
                  transform.target
                )}</small></span>`
            )
            .join('')}
        </div>
        <div class="record-actions">
          <a class="record-link" href="${escapeHtml(relativeLinkFromRoot(record.recordName))}">Open record page</a>
          <button class="record-link secondary favorite-toggle" type="button" data-favorite-toggle data-record-name="${escapeHtml(
            record.recordName
          )}">Pin favorite</button>
        </div>
      </article>`
    )
    .join('');

  const dependencyCards = dependencyRecords
    .map(
      (record) => `<article class="record-card">
        <h3>${escapeHtml(toTitleCase(record.recordName))}</h3>
        <div class="record-meta">
          <span class="pill">${record.stats.operations} endpoints</span>
          <span class="pill">${record.stats.transforms} transforms</span>
        </div>
        <div class="record-copy">${escapeHtml(
          `${record.definition?.refs?.length || 0} schema references and ${
            record.dependencyRecords?.length || 0
          } linked records were captured.`
        )}</div>
        <div class="record-actions">
          <a class="record-link secondary" href="${escapeHtml(
            relativeLinkFromRoot(record.recordName)
          )}">Open dependency</a>
          <button class="record-link secondary favorite-toggle" type="button" data-favorite-toggle data-record-name="${escapeHtml(
            record.recordName
          )}">Pin favorite</button>
        </div>
      </article>`
    )
    .join('');

  const workflowCards = focusTransforms
    .slice(0, 18)
    .map(
      (transform) => `<article class="workflow-card">
        <div class="kicker">Transform</div>
        <h3>${escapeHtml(toTitleCase(transform.source))} to ${escapeHtml(
          toTitleCase(transform.target)
        )}</h3>
        <div class="record-meta">
          <span class="pill">${escapeHtml(transform.method)}</span>
          <span class="pill mono">${escapeHtml(transform.path)}</span>
        </div>
        <div class="record-copy">${escapeHtml(transform.summary || 'Transform route')}</div>
      </article>`
    )
    .join('');

  const recurringBillingCards = billingCardMeta
    .map((meta) => {
      const record = recordMap.get(meta.recordName);

      if (!record) {
        return '';
      }

      return `<article class="record-card">
        <div class="kicker">${escapeHtml(meta.kicker)}</div>
        <h3>${escapeHtml(toTitleCase(record.recordName))}</h3>
        <div class="record-meta">
          <span class="pill">${record.stats.operations} endpoints</span>
          <span class="pill">${record.stats.transforms} transforms</span>
        </div>
        <div class="record-copy">${escapeHtml(meta.summary)}</div>
        <div class="record-actions">
          <a class="record-link secondary" href="${escapeHtml(
            relativeLinkFromRoot(record.recordName)
          )}">Open record page</a>
          <button class="record-link secondary favorite-toggle" type="button" data-favorite-toggle data-record-name="${escapeHtml(
            record.recordName
          )}">Pin favorite</button>
        </div>
      </article>`;
    })
    .join('');

  const recurringAmountCards = recurringAmountFieldCards
    .map(
      (meta) => `<article class="record-card">
        <div class="kicker">Field explainer</div>
        <h3>${escapeHtml(meta.title)}</h3>
        <div class="record-meta">
          <span class="pill">${escapeHtml(meta.field)}</span>
          <span class="pill">Sales pipeline signal</span>
        </div>
        <div class="record-copy">${escapeHtml(meta.summary)}</div>
        <div class="record-actions">
          <a class="record-link secondary" href="${escapeHtml(
            relativeLinkFromRoot(meta.recordName)
          )}">Open ${escapeHtml(toTitleCase(meta.recordName))}</a>
        </div>
      </article>`
    )
    .join('');

  return pageShell({
    title: 'NetSuite REST API Browser Companion',
    eyebrow: 'Focus Objects + Workflow Links',
    pageKind: 'overview',
    defaultBaseRecord: 'salesOrder',
    intro: `<div class="muted">Generated from ${escapeHtml(
      rawIndex.sourceUrl
    )}. The overview stays focused on your requested records: customer, creditMemo, invoice, itemFulfillment, salesOrder, subsidiary, paymentItem, and partner. Dependency chips and transform routes link outward so you can follow related records without losing the main story.</div>`,
    body: `
      <section class="page-section" data-page-section data-section-id="overview-stats" data-section-title="Overview Stats">
        <div class="grid stats-grid" style="margin-top:22px;">
          <article class="stat-card"><p class="stat-label">Focus Records</p><p class="stat-value">${stats.focusRecords}</p></article>
          <article class="stat-card"><p class="stat-label">Dependency Records</p><p class="stat-value">${stats.dependencyRecords}</p></article>
          <article class="stat-card"><p class="stat-label">Transform Routes</p><p class="stat-value">${stats.transforms}</p></article>
          <article class="stat-card"><p class="stat-label">Scraped Records</p><p class="stat-value">${stats.totalScraped}</p></article>
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="focus-records" data-section-title="Focus Records">
        <div class="section-heading">
          <h2>Focus Records</h2>
          <p>Each record card links to a dedicated page with endpoint accordions, transform-first layouts, and linked dependency navigation.</p>
        </div>
        <div class="grid record-grid">
          ${focusCards}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="transform-highlights" data-section-title="Transform Highlights">
        <div class="section-heading">
          <h2>Transform Highlights</h2>
          <p>Cross-record transformations usually carry the most implementation nuance in NetSuite. This strip surfaces the ones touching your focus records first.</p>
        </div>
        <div class="grid record-grid">
          ${workflowCards}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="recurring-billing" data-section-title="Recurring Billing">
        <div class="section-heading">
          <h2>Recurring Billing</h2>
          <p>This curated slice surfaces the actual SuiteBilling setup objects so the monthly billing implementation story stays separate from the sales-order transform graph.</p>
        </div>
        <div class="grid record-grid">
          ${recurringBillingCards}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="recurring-amount-field-explainers" data-section-title="Recurring Amount Field Explainers">
        <div class="section-heading">
          <h2>Recurring Amount Field Explainers</h2>
          <p>These fields describe recurring value on pipeline records, but they are not the primary REST records used to stand up SuiteBilling subscriptions and monthly billing operations.</p>
        </div>
        <div class="grid record-grid">
          ${recurringAmountCards}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="dependency-pages" data-section-title="Dependency Pages">
        <div class="section-heading">
          <h2>Dependency Pages</h2>
          <p>These linked records showed up in the focus object schemas or endpoint contracts and got their own generated pages so the dependency links have somewhere useful to land.</p>
        </div>
        <div class="grid record-grid">
          ${dependencyCards}
        </div>
      </section>
    `,
  });
}

function renderTransformsPage() {
  const grouped = new Map();
  for (const transform of focusTransforms) {
    if (!grouped.has(transform.source)) {
      grouped.set(transform.source, []);
    }
    grouped.get(transform.source).push(transform);
  }

  const workflowMarkup = Array.from(grouped.entries())
    .map(
      ([source, transforms]) => `<article class="workflow-card">
        <div class="kicker">${escapeHtml(source)}</div>
        <h3>${escapeHtml(toTitleCase(source))}</h3>
        <div class="muted">These are the transform destinations that surfaced in the REST API browser for this source record.</div>
        <div class="chip-row" style="margin-top:14px;">
          ${transforms
            .map(
              (transform) =>
                renderLinkedChip(
                  transform.source,
                  `to ${transform.target}`,
                  allRecordSet.has(transform.target) ? relativeLinkFromRoot(transform.target) : null,
                  `No page generated for ${transform.target}.`
                )
            )
            .join('')}
        </div>
      </article>`
    )
    .join('');

  const matrixRows = focusTransforms
    .map(
      (transform) => `<tr>
        <td>${
          allRecordSet.has(transform.source)
            ? `<a href="${escapeHtml(relativeLinkFromRoot(transform.source))}">${escapeHtml(transform.source)}</a>`
            : `<span title="${escapeHtml(`No page generated for ${transform.source}.`)}">${escapeHtml(transform.source)}</span>`
        }</td>
        <td>${
          allRecordSet.has(transform.target)
            ? `<a href="${escapeHtml(relativeLinkFromRoot(transform.target))}">${escapeHtml(transform.target)}</a>`
            : `<span title="${escapeHtml(`No page generated for ${transform.target}.`)}">${escapeHtml(transform.target)}</span>`
        }</td>
        <td><code>${escapeHtml(transform.path)}</code></td>
        <td>${escapeHtml(transform.summary || 'Transform route')}</td>
      </tr>`
    )
    .join('');

  return pageShell({
    title: 'NetSuite Transform Workflows',
    eyebrow: 'Transform-Centric View',
    pageKind: 'transforms',
    defaultBaseRecord: 'salesOrder',
    intro: `<div class="muted">This page separates transform workflows from the standard CRUD surface so you can scan the source-to-target routes faster. It is especially useful when you are tracing record creation chains like customer to salesOrder to invoice or salesOrder to itemFulfillment.</div>`,
    body: `
      <section class="page-section" data-page-section data-section-id="workflow-groups" data-section-title="Workflow Groups">
        <div class="section-heading">
          <h2>Workflow Groups</h2>
          <p>The cards below cluster transform endpoints by their source record, which makes orchestration patterns easier to recognize.</p>
        </div>
        <div class="grid record-grid">
          ${workflowMarkup}
        </div>
      </section>

      <section class="page-section" data-page-section data-section-id="route-matrix" data-section-title="Route Matrix">
        <div class="section-heading">
          <h2>Route Matrix</h2>
          <p>Use this matrix when you need the exact transform endpoint path without opening each record page individually.</p>
        </div>
        <div class="matrix-card">
          <table class="matrix">
            <thead>
              <tr>
                <th>Source</th>
                <th>Target</th>
                <th>Endpoint</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              ${matrixRows}
            </tbody>
          </table>
        </div>
      </section>
    `,
  });
}

ensureDir(PUBLIC_DIR);
ensureDir(PUBLIC_RECORDS_DIR);
ensureDir(GENERATED_DATA_DIR);
ensureDir(GENERATED_RECORDS_DIR);
ensureDir(GENERATED_WORKFLOWS_DIR);

for (const record of allRecords) {
  writeText(
    path.join(PUBLIC_RECORDS_DIR, `${slugify(record.recordName)}.html`),
    renderRecordPage(record)
  );
}

writeText(PUBLIC_HOME_FILE, renderOverviewPage());
writeText(PUBLIC_TRANSFORMS_FILE, renderTransformsPage());
writeText(WORKFLOW_CONFIG_FILE, `${JSON.stringify(workflowConfig, null, 2)}\n`);
writeJson(path.join(GENERATED_DATA_DIR, 'records-index.json'), generatedRecordsIndex);
writeJson(path.join(GENERATED_DATA_DIR, 'workflow-index.json'), generatedWorkflowIndex);

for (const record of allRecords) {
  writeJson(path.join(GENERATED_RECORDS_DIR, `${slugify(record.recordName)}.json`), buildRecordDetail(record));
}

for (const layout of generatedWorkflowLayouts) {
  writeJson(path.join(GENERATED_WORKFLOWS_DIR, `${layout.slug}.json`), layout);
}

console.log(`Wrote ${PUBLIC_HOME_FILE}`);
console.log(`Wrote ${PUBLIC_TRANSFORMS_FILE}`);
if (unresolvedReferenceMap.size) {
  console.warn('Unresolved dependency references:');

  for (const [recordName, dependencies] of unresolvedReferenceMap.entries()) {
    console.warn(`- ${recordName}: ${Array.from(dependencies).sort().join(', ')}`);
  }
}

console.log(`Wrote ${allRecords.length} record pages to ${PUBLIC_RECORDS_DIR}`);
console.log(`Wrote ${allRecords.length} record detail payloads to ${GENERATED_RECORDS_DIR}`);
console.log(`Wrote ${WORKFLOW_CONFIG_FILE}`);

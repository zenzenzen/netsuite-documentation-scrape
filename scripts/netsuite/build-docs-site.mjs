import fs from 'node:fs';
import path from 'node:path';
import {
  FOCUS_RECORDS,
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
  writeText,
} from './shared.mjs';

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
const focusRecords = FOCUS_RECORDS.map((name) => recordMap.get(name)).filter(Boolean);
const focusDependencyRecords = unique(
  focusRecords.flatMap((record) => record.dependencyRecords || [])
).filter((recordName) => !FOCUS_RECORDS.includes(recordName));
const dependencyRecords = focusDependencyRecords
  .map((recordName) => recordMap.get(recordName))
  .filter(Boolean)
  .slice(0, 30);

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

function buildWorkflowConfig(records, transforms) {
  const focusSet = new Set(FOCUS_RECORDS);
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
        : dependencySet.has(record.recordName)
          ? 'dependency'
          : 'extended',
      summary: summarizeRecord(record),
      docsPath: relativeLinkFromRoot(record.recordName),
      stats: {
        operations: record.stats?.operations || 0,
        transforms: record.stats?.transforms || 0,
        schemaFields: record.stats?.schemaFields || 0,
        outgoingTransforms: outgoingCounts.get(record.recordName) || 0,
        incomingTransforms: incomingCounts.get(record.recordName) || 0,
      },
      dependencies: unique(record.dependencyRecords || []),
      endpoints: (record.operations || []).slice(0, 12).map((operation) => ({
        method: operation.method,
        path: operation.path,
        summary: operation.summary || 'Operation',
        isTransform: Boolean(operation.isTransform),
      })),
    }))
    .sort((left, right) => {
      const weight = { focus: 0, dependency: 1, extended: 2 };
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

function renderPinnedSection() {
  return `
    <details class="tool-panel pinned-panel" data-favorites-panel open>
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
    <section class="workflow-studio" id="workflow-studio" data-workflow-studio data-default-base="${escapeHtml(
      defaultBaseRecord
    )}">
      <div class="section-heading workflow-heading">
        <h2>Workflow Studio</h2>
        <p>Start from a base object, preview the next transform fan-out at 50% opacity, then lock branches forward like a NetSuite skill tree.</p>
      </div>
      <div class="workflow-shell">
        <div class="workflow-toolbar">
          <label class="workflow-label">
            <span>Base object</span>
            <select class="workflow-select" data-workflow-base></select>
          </label>
          <div class="workflow-toolbar-actions">
            <button class="record-link secondary workflow-action" type="button" data-workflow-commit>Lock selected objects</button>
            <button class="record-link secondary workflow-action" type="button" data-workflow-back>Back one level</button>
            <button class="record-link secondary workflow-action" type="button" data-workflow-reset>Reset</button>
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
            <summary class="static-summary">Postman-ready query bundle</summary>
            <div class="tool-panel-body">
              <div class="workflow-copy-row">
                <button class="record-link secondary workflow-action" type="button" data-copy-share-query>Copy share query</button>
                <button class="record-link secondary workflow-action" type="button" data-copy-request-bundle>Copy request bundle</button>
              </div>
              <pre class="workflow-code" data-share-query></pre>
              <pre class="workflow-code" data-request-bundle></pre>
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
  <style>
    :root {
      --bg: #f6f1e8;
      --paper: rgba(255, 255, 255, 0.84);
      --paper-strong: rgba(255, 255, 255, 0.96);
      --ink: #1f2430;
      --muted: #5d6472;
      --line: rgba(31, 36, 48, 0.12);
      --gold: #f2b741;
      --teal: #148f88;
      --coral: #e46b53;
      --blue: #2e71d1;
      --berry: #9c4dcc;
      --shadow: 0 18px 48px rgba(28, 36, 54, 0.12);
      --radius: 24px;
      --mono: "SFMono-Regular", "Menlo", "Monaco", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(242, 183, 65, 0.22), transparent 36%),
        radial-gradient(circle at top right, rgba(156, 77, 204, 0.18), transparent 34%),
        linear-gradient(180deg, #efe6d6 0%, #f9f6ef 42%, #eef6f6 100%);
    }

    a { color: inherit; }

    .shell {
      width: min(1260px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 72px;
    }

    .hero {
      position: sticky;
      top: 0;
      z-index: 10;
      padding: 18px 0 8px;
      backdrop-filter: blur(14px);
    }

    .hero-card {
      display: grid;
      gap: 14px;
      padding: 24px 28px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 28px;
      background: linear-gradient(135deg, rgba(255,255,255,0.92), rgba(255,248,237,0.78));
      box-shadow: var(--shadow);
    }

    .eyebrow {
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--teal);
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.6rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }

    .intro {
      max-width: 780px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.6;
    }

    .top-nav, .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .top-link, .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 999px;
      text-decoration: none;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.78);
      color: var(--ink);
      transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
    }

    .top-link:hover, .chip:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 22px rgba(28, 36, 54, 0.08);
      border-color: rgba(20, 143, 136, 0.34);
    }

    .top-link strong { font-size: 0.95rem; }
    .top-link span, .chip small { color: var(--muted); }

    .grid {
      display: grid;
      gap: 18px;
    }

    .stats-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .stat-card, .panel, .record-card, .workflow-card, .matrix-card {
      border-radius: var(--radius);
      background: var(--paper);
      border: 1px solid rgba(255,255,255,0.7);
      box-shadow: var(--shadow);
    }

    .stat-card {
      padding: 20px;
    }

    .stat-label {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 0.84rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .stat-value {
      margin: 0;
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      margin: 38px 0 16px;
    }

    .section-heading h2 {
      margin: 0;
      font-size: 1.8rem;
      letter-spacing: -0.04em;
    }

    .section-heading p {
      margin: 0;
      color: var(--muted);
      max-width: 620px;
      line-height: 1.6;
    }

    .record-grid {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }

    .record-card, .workflow-card, .matrix-card {
      padding: 22px;
    }

    .record-card h3, .workflow-card h3, .matrix-card h3 {
      margin: 0 0 10px;
      font-size: 1.3rem;
    }

    .record-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 700;
      background: rgba(20, 143, 136, 0.12);
      color: var(--teal);
    }

    .record-copy, .muted {
      color: var(--muted);
      line-height: 1.6;
    }

    .record-link {
      display: inline-flex;
      margin-top: 14px;
      padding: 11px 14px;
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(20, 143, 136, 0.9), rgba(46, 113, 209, 0.9));
      color: white;
      font-weight: 700;
      text-decoration: none;
    }

    .record-link.secondary {
      background: rgba(255, 255, 255, 0.9);
      color: var(--ink);
      border: 1px solid var(--line);
    }

    .panel {
      padding: 24px;
    }

    .accordion {
      display: grid;
      gap: 12px;
    }

    details.endpoint {
      overflow: hidden;
      border: 1px solid rgba(31, 36, 48, 0.08);
      border-radius: 20px;
      background: rgba(255,255,255,0.86);
    }

    details.endpoint[open] {
      border-color: rgba(46, 113, 209, 0.26);
      box-shadow: 0 16px 32px rgba(28, 36, 54, 0.08);
    }

    details.endpoint summary {
      list-style: none;
      cursor: pointer;
      padding: 18px 20px;
      display: grid;
      gap: 10px;
    }

    details.endpoint summary::-webkit-details-marker { display: none; }

    .endpoint-top {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .method-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      padding: 8px 12px;
      border-radius: 999px;
      font-family: var(--mono);
      font-weight: 700;
      font-size: 0.82rem;
      color: white;
    }

    .tone-get { background: linear-gradient(135deg, #148f88, #28b6ad); }
    .tone-post { background: linear-gradient(135deg, #2e71d1, #46a0ff); }
    .tone-patch { background: linear-gradient(135deg, #c35d15, #f39237); }
    .tone-put { background: linear-gradient(135deg, #7a4de0, #ab67ff); }
    .tone-delete { background: linear-gradient(135deg, #bf3148, #f1677d); }
    .tone-neutral { background: linear-gradient(135deg, #4d5566, #7a8396); }

    .endpoint-path {
      font-family: var(--mono);
      font-size: 0.96rem;
      word-break: break-word;
    }

    .endpoint-summary {
      color: var(--muted);
      line-height: 1.5;
    }

    .endpoint-body {
      border-top: 1px solid rgba(31, 36, 48, 0.08);
      padding: 0 20px 18px;
      display: grid;
      gap: 14px;
    }

    .split {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .subpanel {
      padding: 16px;
      border-radius: 18px;
      background: rgba(247, 247, 247, 0.72);
      border: 1px solid rgba(31, 36, 48, 0.06);
    }

    .subpanel h4 {
      margin: 0 0 10px;
      font-size: 1rem;
    }

    .subpanel ul {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
    }

    .subpanel li {
      margin-bottom: 8px;
      line-height: 1.5;
    }

    .schema-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }

    .schema-table th,
    .schema-table td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(31, 36, 48, 0.08);
      vertical-align: top;
    }

    .schema-table th {
      font-size: 0.78rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .schema-table code,
    .mono {
      font-family: var(--mono);
      font-size: 0.92rem;
    }

    .matrix {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
    }

    .matrix th, .matrix td {
      padding: 12px 10px;
      border-bottom: 1px solid rgba(31, 36, 48, 0.08);
      text-align: left;
    }

    .matrix th {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .kicker {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      margin-bottom: 10px;
      background: rgba(242, 183, 65, 0.18);
      color: #8a5b00;
      font-weight: 700;
      font-size: 0.78rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    @media (max-width: 760px) {
      .shell { width: min(100vw - 20px, 1260px); }
      .hero-card, .panel, .record-card, .workflow-card, .matrix-card { padding: 18px; }
      details.endpoint summary, .endpoint-body { padding-left: 16px; padding-right: 16px; }
    }
  </style>
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
    ${renderPinnedSection()}
    ${body}
    ${renderWorkflowStudioSection(defaultBaseRecord)}
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
        `<a class="chip" href="${escapeHtml(linkBuilder(dependency))}"><strong>${escapeHtml(
          dependency
        )}</strong><small>${escapeHtml(toTitleCase(dependency))}</small></a>`
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
                  `<a class="chip" href="${escapeHtml(linkBuilder(dependency))}"><strong>${escapeHtml(
                    dependency
                  )}</strong><small>dependency</small></a>`
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
    .map((operation) => renderEndpointDetails(operation, relativeLinkFromRecord))
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
      <div class="section-heading">
        <h2>${escapeHtml(toTitleCase(record.recordName))}</h2>
        <p>Linked records surface here as navigable chips, so you can jump between record dependencies while you read the endpoint contracts.</p>
      </div>
      <div class="panel">
        ${renderDependencyChips(record, relativeLinkFromRecord)}
      </div>

      <div class="section-heading">
        <h2>Endpoints</h2>
        <p>Transform routes are expanded by default because they usually drive the interesting cross-record workflows in NetSuite.</p>
      </div>
      <div class="accordion">
        ${operationMarkup}
      </div>

      <div class="section-heading" id="schema">
        <h2>Schema Snapshot</h2>
        <p>The definition table highlights the first 40 captured rows from the record schema, which is usually enough to orient yourself before dropping into the raw JSON.</p>
      </div>
      <div class="panel">
        ${renderSchemaTable(record)}
      </div>
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

  return pageShell({
    title: 'NetSuite REST API Browser Companion',
    eyebrow: 'Focus Objects + Workflow Links',
    pageKind: 'overview',
    defaultBaseRecord: 'salesOrder',
    intro: `<div class="muted">Generated from ${escapeHtml(
      rawIndex.sourceUrl
    )}. The overview stays focused on your requested records: customer, creditMemo, invoice, itemFulfillment, salesOrder, subsidiary, paymentItem, and partner. Dependency chips and transform routes link outward so you can follow related records without losing the main story.</div>`,
    body: `
      <div class="grid stats-grid" style="margin-top:22px;">
        <article class="stat-card"><p class="stat-label">Focus Records</p><p class="stat-value">${stats.focusRecords}</p></article>
        <article class="stat-card"><p class="stat-label">Dependency Records</p><p class="stat-value">${stats.dependencyRecords}</p></article>
        <article class="stat-card"><p class="stat-label">Transform Routes</p><p class="stat-value">${stats.transforms}</p></article>
        <article class="stat-card"><p class="stat-label">Scraped Records</p><p class="stat-value">${stats.totalScraped}</p></article>
      </div>

      <div class="section-heading">
        <h2>Focus Records</h2>
        <p>Each record card links to a dedicated page with endpoint accordions, transform-first layouts, and linked dependency navigation.</p>
      </div>
      <div class="grid record-grid">
        ${focusCards}
      </div>

      <div class="section-heading">
        <h2>Transform Highlights</h2>
        <p>Cross-record transformations usually carry the most implementation nuance in NetSuite. This strip surfaces the ones touching your focus records first.</p>
      </div>
      <div class="grid record-grid">
        ${workflowCards}
      </div>

      <div class="section-heading">
        <h2>Dependency Pages</h2>
        <p>These linked records showed up in the focus object schemas or endpoint contracts and got their own generated pages so the dependency links have somewhere useful to land.</p>
      </div>
      <div class="grid record-grid">
        ${dependencyCards}
      </div>
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
                `<a class="chip" href="${escapeHtml(relativeLinkFromRoot(source))}"><strong>${escapeHtml(
                  transform.source
                )}</strong><small>to ${escapeHtml(transform.target)}</small></a>`
            )
            .join('')}
        </div>
      </article>`
    )
    .join('');

  const matrixRows = focusTransforms
    .map(
      (transform) => `<tr>
        <td><a href="${escapeHtml(relativeLinkFromRoot(transform.source))}">${escapeHtml(
          transform.source
        )}</a></td>
        <td><a href="${escapeHtml(relativeLinkFromRoot(transform.target))}">${escapeHtml(
          transform.target
        )}</a></td>
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
      <div class="section-heading">
        <h2>Workflow Groups</h2>
        <p>The cards below cluster transform endpoints by their source record, which makes orchestration patterns easier to recognize.</p>
      </div>
      <div class="grid record-grid">
        ${workflowMarkup}
      </div>

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
    `,
  });
}

ensureDir(PUBLIC_DIR);
ensureDir(PUBLIC_RECORDS_DIR);

for (const record of [...focusRecords, ...dependencyRecords]) {
  writeText(
    path.join(PUBLIC_RECORDS_DIR, `${slugify(record.recordName)}.html`),
    renderRecordPage(record)
  );
}

writeText(PUBLIC_HOME_FILE, renderOverviewPage());
writeText(PUBLIC_TRANSFORMS_FILE, renderTransformsPage());
writeText(WORKFLOW_CONFIG_FILE, `${JSON.stringify(workflowConfig, null, 2)}\n`);

console.log(`Wrote ${PUBLIC_HOME_FILE}`);
console.log(`Wrote ${PUBLIC_TRANSFORMS_FILE}`);
console.log(`Wrote ${focusRecords.length + dependencyRecords.length} record pages to ${PUBLIC_RECORDS_DIR}`);
console.log(`Wrote ${WORKFLOW_CONFIG_FILE}`);

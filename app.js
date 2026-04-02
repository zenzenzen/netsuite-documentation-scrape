function readJsonScript(id, fallback) {
  const node = document.getElementById(id);
  if (!node?.textContent) {
    return fallback;
  }

  try {
    return JSON.parse(node.textContent);
  } catch (error) {
    console.error(`Failed to parse ${id}`, error);
    return fallback;
  }
}

function resolveDocHref(docsPath, rootPrefix = './') {
  const value = String(docsPath || '');

  if (!value) {
    return '#';
  }

  if (value.startsWith('/')) {
    return value;
  }

  return `${rootPrefix}${value.replace(/^\.\//, '')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function titleCase(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function copyText(value) {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard API unavailable'));
  }

  return navigator.clipboard.writeText(value);
}

const POSTMAN_ACTIVE_QUERY_ROOT = 'https://8296871.suitetalk.api.netsuite.com/services/rest/record/v1';

class LocalStateStore {
  constructor(prefix = 'netsuite-docs') {
    this.prefix = prefix;
  }

  key(name) {
    return `${this.prefix}:${name}`;
  }

  read(name, fallback) {
    try {
      const raw = window.localStorage.getItem(this.key(name));
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn(`Unable to read local state for ${name}`, error);
      return fallback;
    }
  }

  write(name, value) {
    try {
      window.localStorage.setItem(this.key(name), JSON.stringify(value));
    } catch (error) {
      console.warn(`Unable to persist local state for ${name}`, error);
    }
  }
}

class WorkflowRepository {
  constructor(config, pageContext) {
    this.config = config || { records: [], transforms: [] };
    this.pageContext = pageContext || {};
    this.recordMap = new Map();
    this.slugMap = new Map();
    this.outgoingMap = new Map();

    for (const record of this.config.records || []) {
      this.recordMap.set(record.recordName, record);
      this.slugMap.set(record.slug, record);
      this.slugMap.set(record.recordName.toLowerCase(), record);
    }

    for (const transform of this.config.transforms || []) {
      if (!this.outgoingMap.has(transform.source)) {
        this.outgoingMap.set(transform.source, []);
      }
      this.outgoingMap.get(transform.source).push(transform);
    }
  }

  getRecord(reference) {
    if (!reference) {
      return null;
    }

    return this.recordMap.get(reference) || this.slugMap.get(String(reference).toLowerCase()) || null;
  }

  listBaseRecords() {
    return [...(this.config.records || [])]
      .filter((record) => record.stats?.outgoingTransforms || record.stats?.transforms)
      .sort((left, right) => left.title.localeCompare(right.title) || left.recordName.localeCompare(right.recordName));
  }

  getOutgoing(recordNames) {
    const edges = [];

    for (const recordName of recordNames) {
      edges.push(...(this.outgoingMap.get(recordName) || []));
    }

    const uniqueTargets = new Map();
    for (const edge of edges) {
      if (!uniqueTargets.has(edge.target)) {
        uniqueTargets.set(edge.target, edge);
      }
    }

    return [...uniqueTargets.values()];
  }

  getDocHref(recordReference) {
    const record = this.getRecord(recordReference);
    return record ? resolveDocHref(record.docsPath, this.pageContext.rootPrefix || './') : '#';
  }

  findTransform(source, target) {
    return (this.outgoingMap.get(source) || []).find((transform) => transform.target === target) || null;
  }

  buildShareQuery(baseRecord, lockedLevels) {
    const params = new URLSearchParams();
    params.set('base', baseRecord);

    if (lockedLevels.length > 1) {
      params.set(
        'levels',
        lockedLevels
          .slice(1)
          .map((level) => level.join(','))
          .join(';')
      );
    }

    return params.toString();
  }

  parseShareQuery() {
    const params = new URLSearchParams(window.location.search);
    const base = params.get('base');
    const rawLevels = params.get('levels');

    if (!base || !this.getRecord(base)) {
      return null;
    }

    const lockedLevels = [[this.getRecord(base).recordName]];

    if (rawLevels) {
      for (const rawLevel of rawLevels.split(';')) {
        const items = unique(
          rawLevel
            .split(',')
            .map((item) => this.getRecord(item)?.recordName)
            .filter(Boolean)
        );

        if (items.length) {
          lockedLevels.push(items);
        }
      }
    }

    return {
      baseRecord: this.getRecord(base).recordName,
      lockedLevels,
    };
  }

  buildRequestBundle(baseRecord, lockedLevels) {
    const selectedTransforms = [];

    for (let index = 0; index < lockedLevels.length - 1; index += 1) {
      for (const source of lockedLevels[index]) {
        for (const target of lockedLevels[index + 1]) {
          const transform = this.findTransform(source, target);
          if (transform) {
            selectedTransforms.push(transform);
          }
        }
      }
    }

    const seenRequests = new Set();
    const requests = [];

    const appendRequest = (request) => {
      const key = `${request.method}:${request.url}`;
      if (!seenRequests.has(key)) {
        seenRequests.add(key);
        requests.push(request);
      }
    };

    const allRecords = unique(lockedLevels.flat());
    for (const recordName of allRecords) {
      appendRequest({
        name: `GET ${recordName}`,
        method: 'GET',
        url: `{{NETSUITE_BASE_URL}}/services/rest/record/v1/${recordName}/{{${recordName}Id}}`,
      });
    }

    for (const transform of selectedTransforms) {
      appendRequest({
        name: `POST ${transform.source} -> ${transform.target}`,
        method: 'POST',
        url: `{{NETSUITE_BASE_URL}}/services/rest/record/v1${transform.path.replace('{id}', `{{${transform.source}Id}}`)}`,
      });
    }

    return {
      shareQuery: this.buildShareQuery(baseRecord, lockedLevels),
      selectedTransforms,
      requests,
    };
  }

  buildActiveQuery(recordReference) {
    const record = this.getRecord(recordReference);
    const recordName = record?.recordName || recordReference;

    return {
      name: `GET ${recordName}`,
      method: 'GET',
      url: `${POSTMAN_ACTIVE_QUERY_ROOT}/${recordName}/{{${recordName}Id}}`,
    };
  }

  buildAtomicConfig(baseRecord, lockedLevels) {
    const bundle = this.buildRequestBundle(baseRecord, lockedLevels);

    return {
      version: 1,
      baseRecord,
      vector: lockedLevels.map((records, depth) => ({ depth, records })),
      selectedTransforms: bundle.selectedTransforms.map((transform) => ({
        source: transform.source,
        target: transform.target,
        method: transform.method,
        path: transform.path,
      })),
    };
  }
}

class FavoritesController {
  constructor(store, repository) {
    this.store = store;
    this.repository = repository;
    this.favoriteNames = this.store.read('favorites', []);
    this.panels = [];
  }

  getAll() {
    return this.favoriteNames
      .map((name) => this.repository.getRecord(name))
      .filter(Boolean);
  }

  isFavorite(recordName) {
    return this.favoriteNames.includes(recordName);
  }

  toggle(recordName) {
    if (!recordName) {
      return;
    }

    if (this.isFavorite(recordName)) {
      this.favoriteNames = this.favoriteNames.filter((name) => name !== recordName);
    } else {
      this.favoriteNames = unique([...this.favoriteNames, recordName]);
    }

    this.store.write('favorites', this.favoriteNames);
    this.sync();
  }

  attachPanel(panel) {
    if (panel) {
      this.panels.push(panel);
      this.renderPanel(panel);
    }
  }

  sync() {
    this.renderButtons();
    for (const panel of this.panels) {
      this.renderPanel(panel);
    }

    document.dispatchEvent(
      new CustomEvent('favorites:changed', {
        detail: this.getAll(),
      })
    );
  }

  renderButtons() {
    document.querySelectorAll('[data-favorite-toggle]').forEach((button) => {
      const recordName = button.getAttribute('data-record-name');
      const active = this.isFavorite(recordName);
      button.classList.toggle('is-active', active);
      button.textContent = active ? 'Pinned favorite' : 'Pin favorite';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  renderPanel(panel) {
    const favorites = this.getAll();
    const countNode = panel.querySelector('[data-favorites-count]');
    const listNode = panel.querySelector('[data-favorites-list]');

    if (countNode) {
      countNode.textContent = `${favorites.length} pinned`;
    }

    if (!listNode) {
      return;
    }

    if (!favorites.length) {
      listNode.innerHTML = '<div class="workflow-empty">No pinned objects yet. Pin a record to keep it in this quick-access section.</div>';
      return;
    }

    listNode.innerHTML = favorites
      .map(
        (record) => `
          <article class="favorite-card">
            <div class="favorite-card-title">${escapeHtml(record.title)}</div>
            <div class="favorite-card-copy">${escapeHtml(record.summary)}</div>
            <div class="favorite-card-actions">
              <a class="record-link secondary" href="${escapeHtml(this.repository.getDocHref(record.recordName))}">Open docs</a>
              <button class="record-link secondary favorite-toggle is-active" type="button" data-favorite-toggle data-record-name="${escapeHtml(record.recordName)}">Pinned favorite</button>
            </div>
          </article>
        `
      )
      .join('');
  }
}

class NavPanelController {
  constructor(store, pageContext, repository, favorites) {
    this.store = store;
    this.pageContext = pageContext;
    this.repository = repository;
    this.favorites = favorites;
    this.root = document.querySelector('[data-nav-panel]');
    this.uiState = this.store.read('nav-ui', {
      collapsed: false,
      width: 270,
      favoriteGroupOpen: true,
    });
  }

  mount() {
    if (!this.root) {
      return;
    }

    document.body.classList.add('has-side-nav');
    document.body.classList.toggle('nav-collapsed', Boolean(this.uiState.collapsed));
    document.documentElement.style.setProperty('--nav-panel-width', `${this.uiState.width || 270}px`);

    this.render();
    document.addEventListener('favorites:changed', () => this.renderFavoritesOnly());
  }

  render() {
    const currentRecord = this.repository.getRecord(this.pageContext.currentRecordName);
    const currentRecordHref = document.querySelector('#schema') ? '#schema' : '#record-links';

    this.root.innerHTML = `
      <div class="nav-panel-inner">
        <div class="nav-topbar">
          <div class="nav-brand">
            <div class="nav-brand-mark">NS</div>
            <div class="nav-brand-copy">
              <strong>Object Atlas</strong>
              <span>Docs + workflow map</span>
            </div>
          </div>
          <button class="nav-toggle" type="button" data-nav-toggle aria-label="Collapse navigation">${this.uiState.collapsed ? '>>' : '<<'}</button>
        </div>

        <div class="nav-groups">
          <div class="nav-group">
            <div class="nav-group-header">
              <strong>Navigate</strong>
              <span>Pages + tools</span>
            </div>
            <div class="nav-link-list">
              ${this.renderPrimaryLink('OV', 'Overview', 'Focus records', this.pageContext.homeHref)}
              ${this.renderPrimaryLink('TR', 'Transforms', 'Workflow map', this.pageContext.transformsHref)}
              ${this.renderPrimaryLink('WF', 'Workflow studio', 'Skill-tree explorer', '#workflow-studio')}
            </div>
          </div>

          ${
            currentRecord
              ? `
            <a class="nav-record-link nav-current-record" href="${escapeHtml(currentRecordHref)}">
              <span class="nav-link-icon">CR</span>
              <span class="nav-record-copy">
                <strong>${escapeHtml(currentRecord.title)}</strong>
                <small>Current record page</small>
              </span>
            </a>
          `
              : ''
          }

          <div class="nav-group">
            <details ${this.uiState.favoriteGroupOpen ? 'open' : ''} data-nav-favorites>
              <summary>
                <div class="nav-group-header">
                  <strong>Favorites</strong>
                  <span>${this.favorites.getAll().length} pinned</span>
                </div>
              </summary>
              <div class="nav-favorites-list" data-nav-favorites-list></div>
            </details>
          </div>

          <div class="nav-group">
            <div class="nav-group-header">
              <strong>Section Layout</strong>
              <span>Drag to reorder</span>
            </div>
            <div class="nav-section-list" data-nav-section-layout></div>
          </div>

          <div class="nav-resize">
            <div class="nav-group-header">
              <strong>Panel Size</strong>
              <span class="nav-resize-label">Smaller or wider</span>
            </div>
            <div class="nav-resize-row">
              <button class="nav-resize-chip" type="button" data-nav-size="220">Slim</button>
              <button class="nav-resize-chip" type="button" data-nav-size="270">Default</button>
              <button class="nav-resize-chip" type="button" data-nav-size="320">Wide</button>
            </div>
            <input class="nav-resizer" type="range" min="220" max="340" step="5" value="${this.uiState.width || 270}" data-nav-resizer>
          </div>
        </div>
      </div>
    `;

    this.renderFavoritesOnly();
    this.bind();
    document.dispatchEvent(new CustomEvent('nav:rendered'));
  }

  renderPrimaryLink(icon, title, subtitle, href) {
    return `
      <a class="nav-link" href="${escapeHtml(href)}">
        <span class="nav-link-icon">${escapeHtml(icon)}</span>
        <span class="nav-link-copy">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(subtitle)}</small>
        </span>
      </a>
    `;
  }

  renderFavoritesOnly() {
    const node = this.root?.querySelector('[data-nav-favorites-list]');
    if (!node) {
      return;
    }

    const favorites = this.favorites.getAll();
    if (!favorites.length) {
      node.innerHTML = '<div class="nav-favorite-empty">Pin records to keep a compact shortlist in this panel.</div>';
      return;
    }

    node.innerHTML = favorites
      .map(
        (record) => `
          <a class="nav-favorite-row" href="${escapeHtml(this.repository.getDocHref(record.recordName))}">
            <span class="nav-link-icon">${escapeHtml(record.title.slice(0, 2).toUpperCase())}</span>
            <span class="nav-link-copy">
              <strong>${escapeHtml(record.title)}</strong>
              <small>${escapeHtml(record.stats.transforms)} transforms</small>
            </span>
          </a>
        `
      )
      .join('');
  }

  bind() {
    this.root.querySelector('[data-nav-toggle]')?.addEventListener('click', () => {
      this.uiState.collapsed = !this.uiState.collapsed;
      this.persist();
      this.render();
    });

    this.root.querySelector('[data-nav-resizer]')?.addEventListener('input', (event) => {
      this.uiState.width = Number(event.currentTarget.value);
      this.persist();
      document.documentElement.style.setProperty('--nav-panel-width', `${this.uiState.width}px`);
    });

    this.root.querySelectorAll('[data-nav-size]').forEach((button) => {
      button.addEventListener('click', () => {
        this.uiState.width = Number(button.getAttribute('data-nav-size'));
        this.persist();
        document.documentElement.style.setProperty('--nav-panel-width', `${this.uiState.width}px`);
        this.root.querySelector('[data-nav-resizer]').value = String(this.uiState.width);
      });
    });

    this.root.querySelector('[data-nav-favorites]')?.addEventListener('toggle', (event) => {
      this.uiState.favoriteGroupOpen = event.currentTarget.open;
      this.persist();
    });

    this.root.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        const target = document.querySelector(anchor.getAttribute('href'));
        if (!target) {
          return;
        }

        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${anchor.getAttribute('href')}`);
      });
    });
  }

  persist() {
    this.store.write('nav-ui', this.uiState);
    document.body.classList.toggle('nav-collapsed', Boolean(this.uiState.collapsed));
  }
}

class SectionLayoutController {
  constructor(store, pageContext) {
    this.store = store;
    this.pageContext = pageContext;
    this.pageBody = document.querySelector('[data-page-body]');
    this.draggingSectionId = null;
    this.dropTargetSectionId = null;
    this.dropPosition = null;
  }

  get storageKey() {
    return `section-layout:${this.pageContext.pageKind || 'page'}:${this.pageContext.currentRecordName || 'root'}`;
  }

  getSections() {
    return [...(this.pageBody?.querySelectorAll(':scope > [data-page-section]') || [])];
  }

  mount() {
    if (!this.pageBody) {
      return;
    }

    this.applySavedOrder();
    this.renderIntoNav();
    document.addEventListener('nav:rendered', () => this.renderIntoNav());
  }

  applySavedOrder() {
    const savedOrder = this.store.read(this.storageKey, []);
    if (!savedOrder.length) {
      return;
    }

    const byId = new Map(
      this.getSections().map((section) => [section.getAttribute('data-section-id'), section])
    );

    for (const sectionId of savedOrder) {
      const section = byId.get(sectionId);
      if (section) {
        this.pageBody.appendChild(section);
      }
    }
  }

  saveOrder() {
    this.store.write(
      this.storageKey,
      this.getSections().map((section) => section.getAttribute('data-section-id'))
    );
  }

  moveSection(sourceId, targetId, placement = 'after') {
    if (!sourceId || !targetId) {
      return;
    }

    const sections = this.getSections();
    const source = sections.find((section) => section.getAttribute('data-section-id') === sourceId);
    const target = sections.find((section) => section.getAttribute('data-section-id') === targetId);

    if (!source || !target) {
      return;
    }

    if (source === target) {
      return;
    }

    const insertionPoint = placement === 'before' ? target : target.nextSibling;
    this.pageBody.insertBefore(source, insertionPoint);

    this.saveOrder();
    this.clearDropIndicator();
    this.renderIntoNav();
  }

  updateDropIndicator(targetId, position) {
    this.dropTargetSectionId = targetId;
    this.dropPosition = position;
    const container = document.querySelector('[data-nav-section-layout]');
    if (!container) {
      return;
    }

    container.querySelectorAll('[data-nav-section-item]').forEach((item) => {
      const sectionId = item.getAttribute('data-section-id');
      const active = sectionId === targetId && this.draggingSectionId && sectionId !== this.draggingSectionId;
      item.classList.toggle('is-drop-before', active && position === 'before');
      item.classList.toggle('is-drop-after', active && position === 'after');
    });
  }

  clearDropIndicator() {
    this.dropTargetSectionId = null;
    this.dropPosition = null;
    const container = document.querySelector('[data-nav-section-layout]');
    if (!container) {
      return;
    }

    container.querySelectorAll('[data-nav-section-item]').forEach((item) => {
      item.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  renderIntoNav() {
    const container = document.querySelector('[data-nav-section-layout]');
    if (!container) {
      return;
    }

    const sections = this.getSections();
    container.innerHTML = sections
      .map((section, index) => {
        const sectionId = section.getAttribute('data-section-id');
        const title = section.getAttribute('data-section-title') || `Section ${index + 1}`;
        const isDropBefore =
          this.draggingSectionId &&
          this.dropTargetSectionId === sectionId &&
          this.dropPosition === 'before' &&
          this.draggingSectionId !== sectionId;
        const isDropAfter =
          this.draggingSectionId &&
          this.dropTargetSectionId === sectionId &&
          this.dropPosition === 'after' &&
          this.draggingSectionId !== sectionId;
        return `
          <div class="nav-section-item ${isDropBefore ? 'is-drop-before' : ''} ${isDropAfter ? 'is-drop-after' : ''}" draggable="true" data-nav-section-item data-section-id="${escapeHtml(sectionId)}">
            <button class="nav-section-button" type="button" data-scroll-section="${escapeHtml(sectionId)}">
              <span class="nav-section-handle">::</span>
              <span class="nav-section-copy">${escapeHtml(title)}</span>
            </button>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('[data-nav-section-item]').forEach((item) => {
      item.addEventListener('dragstart', (event) => {
        this.draggingSectionId = item.getAttribute('data-section-id');
        event.dataTransfer.effectAllowed = 'move';
        item.classList.add('is-dragging');
      });

      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const position = event.clientY < midpoint ? 'before' : 'after';
        this.updateDropIndicator(item.getAttribute('data-section-id'), position);
      });

      item.addEventListener('dragleave', (event) => {
        if (!item.contains(event.relatedTarget)) {
          item.classList.remove('is-drop-before', 'is-drop-after');
        }
      });

      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const position = event.clientY < midpoint ? 'before' : 'after';
        this.moveSection(this.draggingSectionId, item.getAttribute('data-section-id'), position);
        this.draggingSectionId = null;
      });

      item.addEventListener('dragend', () => {
        this.draggingSectionId = null;
        item.classList.remove('is-dragging');
        this.clearDropIndicator();
      });
    });

    container.querySelectorAll('[data-scroll-section]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = this.pageBody.querySelector(
          `[data-section-id="${button.getAttribute('data-scroll-section')}"]`
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }
}

class WorkflowStudioController {
  constructor(store, repository, favorites, pageContext) {
    this.store = store;
    this.repository = repository;
    this.favorites = favorites;
    this.pageContext = pageContext;
    this.root = document.querySelector('[data-workflow-studio]');
    this.pendingSelection = [];
    this.state = null;
  }

  mount() {
    if (!this.root) {
      return;
    }

    const queryState = this.repository.parseShareQuery();
    const savedState = this.store.read('workflow-state', null);
    const defaultBaseRecord =
      queryState?.baseRecord ||
      savedState?.baseRecord ||
      this.root.getAttribute('data-default-base') ||
      'salesOrder';

    this.state = {
      baseRecord: defaultBaseRecord,
      lockedLevels: queryState?.lockedLevels || savedState?.lockedLevels || [[defaultBaseRecord]],
    };

    if (!this.repository.getRecord(this.state.baseRecord)) {
      this.state.baseRecord = this.repository.listBaseRecords()[0]?.recordName || 'salesOrder';
      this.state.lockedLevels = [[this.state.baseRecord]];
    }

    this.pendingSelection = [];
    document.addEventListener('favorites:changed', () => this.render());
    this.render();
  }

  reset(baseRecord = this.state.baseRecord) {
    this.state = {
      baseRecord,
      lockedLevels: [[baseRecord]],
    };
    this.pendingSelection = [];
    this.sync();
  }

  commitSelection() {
    if (!this.pendingSelection.length) {
      return;
    }

    this.state.lockedLevels.push([...this.pendingSelection]);
    this.pendingSelection = [];
    this.sync();
  }

  backOneLevel() {
    if (this.pendingSelection.length) {
      this.pendingSelection = [];
      this.render();
      return;
    }

    if (this.state.lockedLevels.length > 1) {
      this.state.lockedLevels.pop();
      this.sync();
    }
  }

  togglePreview(recordName) {
    if (this.pendingSelection.includes(recordName)) {
      this.pendingSelection = this.pendingSelection.filter((name) => name !== recordName);
    } else {
      this.pendingSelection = [...this.pendingSelection, recordName];
    }

    this.render();
  }

  getPreviewEdges() {
    return this.repository.getOutgoing(this.state.lockedLevels[this.state.lockedLevels.length - 1] || []);
  }

  sync() {
    this.store.write('workflow-state', this.state);
    const shareQuery = this.repository.buildShareQuery(this.state.baseRecord, this.state.lockedLevels);
    const nextUrl = `${window.location.pathname}?${shareQuery}${window.location.hash || ''}`;
    window.history.replaceState({}, '', nextUrl);
    this.render();
  }

  render() {
    const baseSelect = this.root.querySelector('[data-workflow-base]');
    const treeNode = this.root.querySelector('[data-workflow-tree]');
    const commitButton = this.root.querySelector('[data-workflow-commit]');
    const backButton = this.root.querySelector('[data-workflow-back]');
    const resetButton = this.root.querySelector('[data-workflow-reset]');
    const shareQueryNode = this.root.querySelector('[data-share-query]');
    const activeQueryNode = this.root.querySelector('[data-active-query]');
    const activeQueryNoteNode = this.root.querySelector('[data-active-query-note]');
    const configNode = this.root.querySelector('[data-workflow-config-output]');

    if (!baseSelect.dataset.ready) {
      baseSelect.innerHTML = this.repository
        .listBaseRecords()
        .map(
          (record) => `
            <option value="${escapeHtml(record.recordName)}">${escapeHtml(record.title)} (${record.stats.outgoingTransforms} transforms)</option>
          `
        )
        .join('');
      baseSelect.dataset.ready = 'true';

      baseSelect.addEventListener('change', (event) => {
        this.reset(event.currentTarget.value);
      });

      commitButton.addEventListener('click', () => this.commitSelection());
      backButton.addEventListener('click', () => this.backOneLevel());
      resetButton.addEventListener('click', () => this.reset());

      this.root.querySelector('[data-copy-share-query]')?.addEventListener('click', async () => {
        const bundle = this.repository.buildRequestBundle(this.state.baseRecord, this.state.lockedLevels);
        await copyText(bundle.shareQuery).catch((error) => console.warn(error));
      });
    }

    baseSelect.value = this.state.baseRecord;
    commitButton.disabled = this.pendingSelection.length === 0;
    backButton.disabled = this.pendingSelection.length === 0 && this.state.lockedLevels.length === 1;
    commitButton.textContent = 'Lock selected objects';
    backButton.textContent = this.pendingSelection.length ? 'Clear queued selection' : 'Step back one level';
    resetButton.textContent = 'Reset to base';
    commitButton.title = 'Promote the queued preview objects into the next locked level.';
    backButton.title = this.pendingSelection.length
      ? 'Clear the currently queued preview objects.'
      : 'Step back one locked level.';
    resetButton.title = 'Return the route to the base object.';

    const previewEdges = this.getPreviewEdges();
    const previewRecords = previewEdges
      .map((edge) => this.repository.getRecord(edge.target))
      .filter(Boolean);

    const columns = this.state.lockedLevels
      .map((level, index) => this.renderLockedColumn(level, index))
      .join('');

    const previewColumn = previewRecords.length
      ? this.renderPreviewColumn(previewRecords)
      : `
        <section class="workflow-column">
          <div class="workflow-column-title">
            <strong>Next branch</strong>
            <span>0 objects</span>
          </div>
          <div class="workflow-empty">No further transforms detected from the currently locked frontier.</div>
        </section>
      `;

    treeNode.innerHTML = `${columns}${previewColumn}`;

    treeNode.querySelectorAll('[data-preview-record]').forEach((button) => {
      button.addEventListener('click', () => this.togglePreview(button.getAttribute('data-preview-record')));
    });

    treeNode.querySelectorAll('[data-open-doc]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const href = button.getAttribute('data-open-doc');
        window.open(href, '_blank', 'noopener,noreferrer');
      });
    });

    treeNode.querySelectorAll('[data-workflow-pin]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.favorites.toggle(button.getAttribute('data-workflow-pin'));
      });
    });

    const bundle = this.repository.buildRequestBundle(this.state.baseRecord, this.state.lockedLevels);
    const activeQuery = this.repository.buildActiveQuery(this.state.baseRecord);
    shareQueryNode.textContent = `?${bundle.shareQuery}`;
    activeQueryNode.textContent = `${activeQuery.method} ${activeQuery.url}`;
    activeQueryNoteNode.textContent = 'GET requests do not require request body data.';
    configNode.textContent = JSON.stringify(
      this.repository.buildAtomicConfig(this.state.baseRecord, this.state.lockedLevels),
      null,
      2
    );
  }

  renderLockedColumn(level, index) {
    const cards = level
      .map((recordName) => {
        const record = this.repository.getRecord(recordName);
        return this.renderNodeCard(record, 'locked');
      })
      .join('');

    return `
      <section class="workflow-column">
        <div class="workflow-column-title">
          <strong>${index === 0 ? 'Base object' : `Locked level ${index}`}</strong>
          <span>${level.length} object${level.length === 1 ? '' : 's'}</span>
        </div>
        ${cards}
      </section>
    `;
  }

  renderPreviewColumn(records) {
    return `
      <section class="workflow-column">
        <div class="workflow-column-title">
          <strong>Next branch</strong>
          <span>${records.length} object${records.length === 1 ? '' : 's'}</span>
        </div>
        ${records.map((record) => this.renderNodeCard(record, 'preview', this.pendingSelection.includes(record.recordName))).join('')}
      </section>
    `;
  }

  renderNodeCard(record, mode, selected = false) {
    if (!record) {
      return '';
    }

    const buttonLabel = mode === 'preview' ? 'Queue branch' : 'Locked branch';
    const favoriteActive = this.favorites.isFavorite(record.recordName);

    return `
      <article class="workflow-node-card ${escapeHtml(mode)} ${selected ? 'selected' : ''}">
        <button
          class="workflow-node-main"
          type="button"
          ${mode === 'preview' ? `data-preview-record="${escapeHtml(record.recordName)}"` : ''}
        >
          <span class="workflow-node-title">${escapeHtml(record.title)}</span>
          <span class="workflow-node-meta">${escapeHtml(record.summary)}</span>
          <span class="workflow-node-meta">${escapeHtml(
            `${record.stats.operations} endpoints · ${record.stats.outgoingTransforms} outgoing transforms`
          )}</span>
          <span class="workflow-node-meta">${escapeHtml(buttonLabel)}</span>
        </button>
        <div class="workflow-node-actions">
          <button class="workflow-node-doc" type="button" data-open-doc="${escapeHtml(
            this.repository.getDocHref(record.recordName)
          )}" aria-label="Open ${escapeHtml(record.title)} docs">?</button>
          <button class="workflow-node-pin" type="button" data-workflow-pin="${escapeHtml(
            record.recordName
          )}" aria-label="Pin ${escapeHtml(record.title)}">${favoriteActive ? 'P' : '+'}</button>
        </div>
        <div class="workflow-node-tooltip">
          <strong>${escapeHtml(record.title)}</strong>
          <div>${escapeHtml(record.summary)}</div>
          <div style="margin-top:8px;"><a href="${escapeHtml(
            this.repository.getDocHref(record.recordName)
          )}" target="_blank" rel="noopener noreferrer">Open docs in a new tab</a></div>
        </div>
      </article>
    `;
  }
}

const pageContext = readJsonScript('netsuite-page-context', {});

async function loadWorkflowConfig(currentPageContext) {
  const inlineConfig = readJsonScript('netsuite-workflow-config', null);

  if (inlineConfig?.records && inlineConfig?.transforms) {
    return inlineConfig;
  }

  if (!currentPageContext.workflowConfigHref) {
    return { records: [], transforms: [] };
  }

  try {
    const response = await fetch(currentPageContext.workflowConfigHref, {
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load workflow config payload.', error);
    return { records: [], transforms: [] };
  }
}

async function bootstrap() {
  const workflowConfig = await loadWorkflowConfig(pageContext);
  const store = new LocalStateStore();
  const repository = new WorkflowRepository(workflowConfig, pageContext);
  const favorites = new FavoritesController(store, repository);

  document.addEventListener('click', (event) => {
    const favoriteToggle = event.target.closest('[data-favorite-toggle]');
    if (favoriteToggle) {
      favorites.toggle(favoriteToggle.getAttribute('data-record-name'));
    }
  });

  document.querySelectorAll('[data-favorites-panel]').forEach((panel) => favorites.attachPanel(panel));
  favorites.sync();

  const nav = new NavPanelController(store, pageContext, repository, favorites);
  nav.mount();

  const sectionLayout = new SectionLayoutController(store, pageContext);
  sectionLayout.mount();

  const workflowStudio = new WorkflowStudioController(store, repository, favorites, pageContext);
  workflowStudio.mount();
}

bootstrap();

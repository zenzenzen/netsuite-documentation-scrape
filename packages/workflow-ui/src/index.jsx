import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Background, Controls, Handle, Panel, Position, ReactFlow } from '@xyflow/react';
import { animate, stagger } from 'animejs';
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  buildRecordRequest,
  buildShareQuery,
  buildTransformRequest,
  categoryColor,
  findRecordByName,
  findRecordBySlug,
  parseShareQuery,
} from '@netsuite/workflow-core';

function copyText(value) {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard API unavailable'));
  }

  return navigator.clipboard.writeText(value);
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function sortByTitle(records) {
  return [...records].sort((left, right) => left.title.localeCompare(right.title));
}

function buildRecordCatalog(workflowMap, workflowIndex) {
  const catalog = new Map();

  for (const record of workflowIndex) {
    if (record.recordName) {
      catalog.set(record.recordName, record);
    }
    if (record.slug) {
      catalog.set(record.slug, record);
    }
  }

  for (const workflow of workflowMap.values()) {
    for (const layer of workflow.layers || []) {
      for (const node of layer.nodes || []) {
        catalog.set(node.recordName, node);
        if (node.slug) {
          catalog.set(node.slug, node);
        }
      }
    }
  }

  return catalog;
}

function collectInspectionRoute(layout, recordName) {
  if (!layout || !recordName || recordName === layout.baseRecord) {
    return [];
  }

  const layerIndex = layout.layers.findIndex((layer) =>
    layer.nodes.some((node) => node.recordName === recordName)
  );

  if (layerIndex < 1) {
    return [];
  }

  const stages = [];
  let currentTargets = new Set([recordName]);

  for (let depth = layerIndex; depth >= 1; depth -= 1) {
    const sources = layout.layers[depth - 1]?.nodes.map((node) => node.recordName) || [];
    const transforms = layout.edges.filter(
      (edge) => sources.includes(edge.source) && currentTargets.has(edge.target)
    );

    if (!transforms.length) {
      break;
    }

    stages.unshift({ depth, transforms });
    currentTargets = new Set(transforms.map((transform) => transform.source));
  }

  return stages;
}

function buildImmediateTransformRequests(record, resolveRecord, routeStages) {
  if (!record) {
    return [];
  }

  if (routeStages.length) {
    return routeStages.flatMap((stage) =>
      stage.transforms.map((transform) => {
        const sourceRecord = resolveRecord(transform.source);
        const targetRecord = resolveRecord(transform.target);

        return {
          id: transform.id,
          label: `${sourceRecord?.title || transform.source} -> ${targetRecord?.title || transform.target}`,
          summary: transform.summary,
          request: buildTransformRequest(transform),
        };
      })
    );
  }

  return (record.endpoints || [])
    .filter((endpoint) => endpoint.isTransform)
    .map((endpoint) => {
      const targetName = endpoint.path.split('/!transform/')[1] || endpoint.path;
      const targetRecord = resolveRecord(targetName);
      const transform = {
        id: `${record.recordName}:${endpoint.path}`,
        source: record.recordName,
        target: targetRecord?.recordName || targetName,
        path: endpoint.path,
        method: endpoint.method,
        summary: endpoint.summary,
      };

      return {
        id: transform.id,
        label: `${record.title} -> ${targetRecord?.title || transform.target}`,
        summary: transform.summary,
        request: buildTransformRequest(transform),
      };
    });
}

function buildFocusedGraph(layout, favorites, handlers = {}) {
  const nodes = layout.layers.flatMap((layer) => {
    const count = Math.max(1, layer.nodes.length);
    const spread = count > 1 ? count - 1 : 1;

    return layer.nodes.map((node, index) => {
      const tone = categoryColor(node.category || 'other');
      const offset = (hashString(node.recordName) % 28) - 14;

      return {
        id: node.recordName,
        type: 'recordNode',
        position: {
          x: layer.depth === 0 ? 0 : layer.depth * 316 + (layer.depth % 2) * 18,
          y:
            layer.depth === 0
              ? 0
              : Math.round((index - spread / 2) * 146 + offset + layer.depth * 10),
        },
        draggable: false,
        selectable: false,
        style: { pointerEvents: 'all' },
        data: {
          record: node,
          mode: 'focus',
          state: layer.depth === 0 ? 'anchor' : layer.depth === 1 ? 'preview' : 'branch',
          tone,
          favorite: favorites.includes(node.recordName),
          onPrimaryAction: handlers?.onInspect,
        },
      };
    });
  });

  const edges = layout.edges.map((edge) => {
    const active = edge.source === layout.baseRecord;

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      selectable: false,
      focusable: false,
      animated: active,
      style: {
        stroke: active ? 'rgba(20, 143, 136, 0.7)' : 'rgba(96, 108, 136, 0.28)',
        strokeWidth: active ? 2.2 : 1.2,
      },
    };
  });

  return {
    nodes,
    edges,
    previewTargets: layout.layers[1]?.nodes.map((node) => node.recordName) || [],
  };
}

function TooltipButton({
  tooltip,
  className = '',
  children,
  type = 'button',
  disabled = false,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    },
    []
  );

  function showTooltip(event) {
    if (onMouseEnter) {
      onMouseEnter(event);
    }

    if (!tooltip || disabled) {
      return;
    }

    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    setVisible(true);
    timeoutRef.current = window.setTimeout(() => setVisible(false), 2000);
  }

  function hideTooltip(event) {
    if (onMouseLeave) {
      onMouseLeave(event);
    }

    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    setVisible(false);
  }

  return (
    <button
      type={type}
      className={`workflow-tooltip-button ${className}`.trim()}
      disabled={disabled}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={(event) => {
        if (onFocus) {
          onFocus(event);
        }
        showTooltip(event);
      }}
      onBlur={(event) => {
        if (onBlur) {
          onBlur(event);
        }
        hideTooltip(event);
      }}
      {...props}
    >
      {children}
      {tooltip ? (
        <span className={`workflow-button-tooltip${visible ? ' is-visible' : ''}`}>{tooltip}</span>
      ) : null}
    </button>
  );
}

function RecordNode({ data }) {
  const { record, mode, state, tone, favorite, onPrimaryAction } = data;
  const label =
    mode === 'catalog'
      ? 'Anchor workflow on this object'
      : state === 'anchor'
        ? 'Inspect the anchor object'
        : 'Open endpoint overlay';

  return (
    <div
      className={`workflow-node-shell is-${mode} is-${state}${favorite ? ' is-favorite' : ''}`}
      style={{ '--node-accent': tone.accent, '--node-surface': tone.surface }}
    >
      {mode === 'focus' ? <Handle type="target" position={Position.Left} className="workflow-handle" /> : null}
      <TooltipButton
        className="workflow-node-button"
        tooltip={label}
        aria-label={label}
        onClick={() => onPrimaryAction(record.recordName)}
      >
        <span className="workflow-node-title">{record.title}</span>
      </TooltipButton>
      {mode === 'focus' ? <Handle type="source" position={Position.Right} className="workflow-handle" /> : null}
    </div>
  );
}

const nodeTypes = {
  recordNode: RecordNode,
};

function RecordOverlay({
  record,
  anchorRecord,
  favorite,
  activeQuery,
  transformRequests,
  copyState,
  onClose,
  onCopy,
  onOpenDocs,
  onPin,
  onAnchor,
}) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.body.classList.add('workflow-overlay-open');
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.classList.remove('workflow-overlay-open');
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  if (!record || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="workflow-overlay-backdrop" onClick={onClose}>
      <section
        className="workflow-overlay-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-overlay-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workflow-overlay-header">
          <div>
            <p className="workflow-kicker">Workflow Inspector</p>
            <h2 id="workflow-overlay-title">{record.title}</h2>
            <p className="workflow-overlay-summary">{record.summary}</p>
          </div>
          <TooltipButton
            className="workflow-overlay-close"
            tooltip="Close the overlay"
            aria-label="Close record overlay"
            onClick={onClose}
          >
            ×
          </TooltipButton>
        </div>

        <div className="workflow-pill-row">
          <span className="workflow-mini-pill is-tinted">{record.categoryLabel}</span>
          <span className="workflow-mini-pill">{record.stats.operations} endpoints</span>
          <span className="workflow-mini-pill">{record.stats.outgoingTransforms} outgoing</span>
          <span className="workflow-mini-pill">{record.stats.incomingTransforms} incoming</span>
          {anchorRecord?.recordName === record.recordName ? (
            <span className="workflow-mini-pill">Current anchor</span>
          ) : null}
        </div>

        <div className="workflow-overlay-actions">
          {anchorRecord?.recordName !== record.recordName ? (
            <TooltipButton
              className="workflow-overlay-action is-primary"
              tooltip="Make this record the new anchor"
              onClick={() => onAnchor(record.recordName)}
            >
              Use as anchor
            </TooltipButton>
          ) : null}
          <TooltipButton
            className="workflow-overlay-action"
            tooltip="Open the record documentation in a new tab"
            onClick={() => onOpenDocs(record.docsPath)}
          >
            Open docs
          </TooltipButton>
          <TooltipButton
            className="workflow-overlay-action"
            tooltip={favorite ? 'Unpin this record from favorites' : 'Pin this record to favorites'}
            onClick={() => onPin(record.recordName)}
          >
            {favorite ? 'Unpin record' : 'Pin record'}
          </TooltipButton>
          <TooltipButton
            className="workflow-overlay-action"
            tooltip="Copy the current GET query for this object"
            onClick={() => onCopy(activeQuery.url, 'Active query')}
          >
            Copy active query
          </TooltipButton>
        </div>

        <div className="workflow-overlay-grid">
          <section className="workflow-overlay-panel">
            <span className="workflow-overlay-label">Active query</span>
            <pre>{`${activeQuery.method} ${activeQuery.url}`}</pre>
            <p className="muted">GET requests do not require request body data.</p>
          </section>

          <section className="workflow-overlay-panel">
            <span className="workflow-overlay-label">Immediate transform endpoints</span>
            <div className="workflow-overlay-endpoints">
              {transformRequests.length ? (
                transformRequests.map((item) => (
                  <article className="workflow-endpoint-card" key={item.id}>
                    <strong>{item.label}</strong>
                    <p>{item.summary || 'Transform endpoint'}</p>
                    <pre>{`${item.request.method} ${item.request.url}`}</pre>
                  </article>
                ))
              ) : (
                <p className="muted">
                  No upstream transform is required for this object yet. Inspect a downstream node to see the
                  route-specific transform endpoints.
                </p>
              )}
            </div>
          </section>
        </div>

        {copyState ? <p className="workflow-copy-note">{copyState}</p> : null}
      </section>
    </div>,
    document.body
  );
}

function CatalogGrid({ workflowIndex, favorites, onAnchor }) {
  return (
    <div className="workflow-catalog-grid">
      {sortByTitle(workflowIndex).map((record) => {
        const tone = categoryColor(record.category || 'other');
        return (
          <div
            key={record.recordName}
            className={`workflow-node-shell is-catalog${favorites.includes(record.recordName) ? ' is-favorite' : ''}`}
            style={{ '--node-accent': tone.accent, '--node-surface': tone.surface }}
          >
            <TooltipButton
              className="workflow-node-button"
              tooltip="Anchor workflow on this object"
              aria-label={`Anchor workflow on ${record.title}`}
              onClick={() => onAnchor(record.recordName)}
            >
              <span className="workflow-node-title">{record.title}</span>
            </TooltipButton>
          </div>
        );
      })}
    </div>
  );
}

export function WorkflowStudio({ workflowIndex, initialWorkflow }) {
  const [workflowMap, setWorkflowMap] = useState(() => new Map());
  const [anchorRecordName, setAnchorRecordName] = useState(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const parsed = parseShareQuery(window.location.search, workflowIndex);
    return parsed?.baseRecord || null;
  });
  const [inspectionRecordName, setInspectionRecordName] = useState(null);
  const [favorites, setFavorites] = useState(() => {
    if (typeof window === 'undefined') {
      return [];
    }

    try {
      return JSON.parse(window.localStorage.getItem('netsuite-docs:favorites') || '[]');
    } catch {
      return [];
    }
  });
  const [copyState, setCopyState] = useState('');
  const [loadingSlug, setLoadingSlug] = useState(null);
  const graphRef = useRef(null);
  const recordCatalog = useMemo(() => buildRecordCatalog(workflowMap, workflowIndex), [workflowMap, workflowIndex]);

  function resolveRecord(recordName) {
    return (
      recordCatalog.get(recordName) ||
      findRecordByName(workflowIndex, recordName) ||
      findRecordBySlug(workflowIndex, recordName) ||
      null
    );
  }

  const anchorRecord = useMemo(() => (anchorRecordName ? resolveRecord(anchorRecordName) : null), [anchorRecordName, recordCatalog]);
  const currentWorkflow = useMemo(
    () => (anchorRecord?.slug ? workflowMap.get(anchorRecord.slug) || null : null),
    [anchorRecord, workflowMap]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (anchorRecord?.slug) {
      const query = buildShareQuery(anchorRecord.slug, [[anchorRecord.recordName]]);
      window.history.replaceState({}, '', `${window.location.pathname}?${query}`);
    } else {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [anchorRecord]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('netsuite-docs:favorites', JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (!copyState) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setCopyState(''), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  useEffect(() => {
    if (!anchorRecord?.slug) {
      return;
    }

    ensureWorkflow(anchorRecord.slug).catch((error) => {
      console.error(error);
      setLoadingSlug(null);
    });
  }, [anchorRecord?.slug]);

  useEffect(() => {
    if (!inspectionRecordName) {
      return;
    }

    if (!currentWorkflow) {
      return;
    }

    const visibleNow = new Set(
      currentWorkflow.layers.flatMap((layer) => layer.nodes.map((node) => node.recordName))
    );

    if (!visibleNow.has(inspectionRecordName)) {
      setInspectionRecordName(null);
    }
  }, [currentWorkflow, inspectionRecordName]);

  useEffect(() => {
    if (!graphRef.current) {
      return;
    }

    const nodes = graphRef.current.querySelectorAll('.workflow-node-shell');
    if (!nodes.length) {
      return;
    }

    animate(nodes, {
      opacity: [0, 1],
      translateY: [20, 0],
      scale: [0.985, 1],
      delay: stagger(22),
      duration: 380,
      ease: 'out(3)',
    });
  }, [anchorRecordName, currentWorkflow, favorites, workflowIndex]);

  async function ensureWorkflow(slug) {
    if (workflowMap.has(slug)) {
      return workflowMap.get(slug);
    }

    setLoadingSlug(slug);
    const response = await fetch(`/workflow-data/${slug}.json`);
    if (!response.ok) {
      throw new Error(`Failed to load cached workflow for ${slug}`);
    }

    const payload = await response.json();
    setWorkflowMap((current) => {
      const next = new Map(current);
      next.set(slug, payload);
      return next;
    });
    setLoadingSlug(null);
    return payload;
  }

  function handleAnchor(recordName) {
    const record = resolveRecord(recordName);
    if (!record) {
      return;
    }

    setLoadingSlug(record.slug || record.recordName);
    setInspectionRecordName(null);
    setAnchorRecordName(record.recordName);
  }

  function handleBrowseAll() {
    setInspectionRecordName(null);
    setAnchorRecordName(null);
    setLoadingSlug(null);
  }

  function handleInspect(recordName) {
    setInspectionRecordName(recordName);
  }

  function handlePin(recordName) {
    setFavorites((current) =>
      current.includes(recordName)
        ? current.filter((item) => item !== recordName)
        : [...current, recordName]
    );
  }

  function handleOpenDocs(docsPath) {
    const nextPath = String(docsPath || '').replace(/^\.\//, '/');
    window.open(nextPath, '_blank', 'noopener,noreferrer');
  }

  async function handleCopy(value, label) {
    try {
      await copyText(value);
      setCopyState(`${label} copied`);
    } catch {
      setCopyState(`${label} copy failed`);
    }
  }

  const graph = useMemo(() => {
    if (!anchorRecord || !currentWorkflow) {
      return null;
    }

    return buildFocusedGraph(currentWorkflow, favorites, { onInspect: handleInspect });
  }, [anchorRecord, currentWorkflow, favorites]);

  const graphMode = anchorRecord ? 'focus' : 'catalog';
  const activeRecordName = inspectionRecordName || anchorRecord?.recordName || null;
  const activeRecord = activeRecordName ? resolveRecord(activeRecordName) : anchorRecord;
  const activeQuery = activeRecord ? buildRecordRequest(activeRecord.recordName) : null;
  const inspectionRecord = inspectionRecordName ? resolveRecord(inspectionRecordName) : null;
  const inspectionRoute = useMemo(
    () => (currentWorkflow && inspectionRecordName ? collectInspectionRoute(currentWorkflow, inspectionRecordName) : []),
    [currentWorkflow, inspectionRecordName]
  );
  const overlayTransformRequests = useMemo(
    () =>
      inspectionRecord && currentWorkflow
        ? buildImmediateTransformRequests(inspectionRecord, resolveRecord, inspectionRoute)
        : [],
    [currentWorkflow, inspectionRecord, inspectionRoute, recordCatalog]
  );
  const nextFrontier = useMemo(
    () => currentWorkflow?.layers?.[1]?.nodes || [],
    [currentWorkflow]
  );
  const favoritesMeta = useMemo(
    () => favorites.map((recordName) => resolveRecord(recordName)).filter(Boolean),
    [favorites, recordCatalog]
  );

  const heroTitle = anchorRecord
    ? `${anchorRecord.title} transform atlas`
    : 'Workflow Studio';
  const heroCopy = anchorRecord
    ? `Focused on ${anchorRecord.title}. Click any downstream node to inspect its endpoint chain, or open another object from the catalog to re-anchor the graph.`
    : 'Alphabetized object catalog. Pick a name to anchor the workflow, then explore the projected downstream tree.';

  const stageNote = anchorRecord
    ? loadingSlug
      ? `Loading ${loadingSlug}...`
      : `Focused tree for ${anchorRecord.title}`
    : 'Alphabetized catalog. Pick any object to anchor the workflow.';

  const railPrompt = anchorRecord
    ? `The first downstream layer shows the objects that can be created from ${anchorRecord.title}.`
    : 'Pick any object to anchor the workflow and reveal the first downstream layer.';

  return (
    <section className="workflow-studio-route">
      <header className="workflow-hero-card">
        <div className="workflow-hero-copy">
          <p className="workflow-kicker">Workflow Studio</p>
          <h1>{heroTitle}</h1>
          <p>{heroCopy}</p>
        </div>

        <div className="workflow-toolbar-card">
          <div className="workflow-anchor-summary">
            <span className="workflow-anchor-label">{graphMode === 'catalog' ? 'Catalog mode' : 'Anchor'}</span>
            <strong>{anchorRecord ? anchorRecord.title : `${workflowIndex.length} objects available`}</strong>
            <span className="muted">{railPrompt}</span>
          </div>

          <div className="workflow-toolbar-actions">
            {anchorRecord ? (
              <TooltipButton
                tooltip="Return to the full object catalog"
                onClick={handleBrowseAll}
              >
                Browse all objects
              </TooltipButton>
            ) : null}
            <TooltipButton
              tooltip="Copy the current page link"
              onClick={() => handleCopy(window.location.href, 'Page link')}
            >
              Copy link
            </TooltipButton>
          </div>
        </div>
      </header>

      <div className="workflow-layout-shell">
        <div className="workflow-graph-stage" ref={graphRef}>
          {anchorRecord ? (
            currentWorkflow ? (
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.18, maxZoom: 1.08 }}
                minZoom={0.54}
                maxZoom={1.42}
                panOnScroll
                panOnDrag
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="rgba(96, 108, 136, 0.12)" gap={28} />
                <Controls showInteractive={false} />
                <Panel position="top-left" className="workflow-stage-note">
                  {stageNote}
                </Panel>
                <Panel position="top-right" className="workflow-stage-meta">
                  <span>{graph.nodes.length} nodes</span>
                  <span>{currentWorkflow.layers.length} layers</span>
                </Panel>
              </ReactFlow>
            ) : (
              <div className="workflow-loading-state">
                <strong>Loading anchored workflow…</strong>
                <span>The focused tree appears as soon as the cached workflow payload resolves.</span>
              </div>
            )
          ) : (
            <div className="workflow-catalog-stage">
              <div className="workflow-stage-note workflow-stage-note-static">{stageNote}</div>
              <div className="workflow-stage-meta workflow-stage-meta-static">
                <span>{workflowIndex.length} objects</span>
                <span>Alphabetized</span>
              </div>
              <CatalogGrid workflowIndex={workflowIndex} favorites={favorites} onAnchor={handleAnchor} />
            </div>
          )}
        </div>

        <aside className="workflow-side-rail">
          <section className="workflow-rail-card">
            <h2>{anchorRecord ? 'Focused query' : 'Anchor prompt'}</h2>
            {activeQuery ? (
              <>
                <pre>{`${activeQuery.method} ${activeQuery.url}`}</pre>
                <p className="muted">GET requests do not require request body data.</p>
                <TooltipButton
                  tooltip="Copy the current GET query"
                  onClick={() => handleCopy(activeQuery.url, 'Active query')}
                >
                  Copy active query
                </TooltipButton>
              </>
            ) : (
              <p className="muted">Pick an object from the catalog to anchor the workflow and reveal its query.</p>
            )}
          </section>

          <section className="workflow-rail-card">
            <h2>Next frontier</h2>
            <div className="workflow-pill-stack">
              {anchorRecord ? (
                nextFrontier.length ? (
                  nextFrontier.map((record) => (
                    <span className="workflow-mini-pill is-category" key={record.recordName}>
                      {record.title}
                    </span>
                  ))
                ) : (
                  <span className="muted">No further transforms from this anchor.</span>
                )
              ) : (
                <span className="muted">The first layer will appear here once you anchor an object.</span>
              )}
            </div>
          </section>

          <section className="workflow-rail-card">
            <h2>Pinned favorites</h2>
            <div className="workflow-pill-stack">
              {favoritesMeta.length ? (
                favoritesMeta.map((record) => (
                  <span className="workflow-mini-pill is-favorite" key={record.recordName}>
                    {record.title}
                  </span>
                ))
              ) : (
                <span className="muted">Pin records from the overlay to keep them close.</span>
              )}
            </div>
          </section>
        </aside>
      </div>

      {inspectionRecord && activeQuery ? (
        <RecordOverlay
          record={inspectionRecord}
          anchorRecord={anchorRecord}
          favorite={favorites.includes(inspectionRecord.recordName)}
          activeQuery={buildRecordRequest(inspectionRecord.recordName)}
          transformRequests={overlayTransformRequests}
          copyState={copyState}
          onClose={() => setInspectionRecordName(null)}
          onCopy={handleCopy}
          onOpenDocs={handleOpenDocs}
          onPin={handlePin}
          onAnchor={handleAnchor}
        />
      ) : null}
    </section>
  );
}

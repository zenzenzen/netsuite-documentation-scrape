import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Background, Controls, Handle, Panel, Position, ReactFlow } from '@xyflow/react';
import { animate, stagger } from 'animejs';
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  buildAtomicConfig,
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

function buildPreviewTargets(layout, lockedLevels) {
  const frontier = lockedLevels[lockedLevels.length - 1] || [];
  return Array.from(
    new Set(
      layout.edges
        .filter((edge) => frontier.includes(edge.source))
        .map((edge) => edge.target)
    )
  );
}

function buildNodeStateMap(layout, lockedLevels, pendingSelection) {
  const stateMap = new Map();
  const lockedSet = new Set(lockedLevels.flat());
  const previewSet = new Set(buildPreviewTargets(layout, lockedLevels));

  for (const layer of layout.layers) {
    for (const node of layer.nodes) {
      let state = 'dimmed';

      if (node.recordName === layout.baseRecord) {
        state = 'base';
      } else if (lockedSet.has(node.recordName)) {
        state = 'locked';
      } else if (pendingSelection.includes(node.recordName)) {
        state = 'queued';
      } else if (previewSet.has(node.recordName)) {
        state = 'preview';
      }

      stateMap.set(node.recordName, state);
    }
  }

  return { stateMap, previewSet };
}

function collectInspectionRoute(layout, lockedLevels, recordName) {
  if (!layout || !recordName || recordName === layout.baseRecord) {
    return [];
  }

  const previewTargets = new Set(buildPreviewTargets(layout, lockedLevels));
  const lockedIndex = lockedLevels.findIndex((level) => level.includes(recordName));
  const terminalDepth = lockedIndex >= 0 ? lockedIndex : previewTargets.has(recordName) ? lockedLevels.length : -1;

  if (terminalDepth < 1) {
    return [];
  }

  const stages = [];
  let currentTargets = new Set([recordName]);

  for (let depth = terminalDepth; depth >= 1; depth -= 1) {
    const sources = lockedLevels[depth - 1] || [];
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

function buildRecordCatalog(workflowMap, workflowIndex) {
  const catalog = new Map();

  for (const item of workflowIndex) {
    if (item.recordName) {
      catalog.set(item.recordName, item);
    }
    if (item.slug) {
      catalog.set(item.slug, item);
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

function buildFlowGraph(layout, lockedLevels, pendingSelection, favorites, handlers, nodeState) {
  const { stateMap, previewSet } = nodeState;
  const visibleColumns = [
    ...lockedLevels.map((records, index) => ({ kind: index === 0 ? 'base' : 'locked', records })),
    { kind: 'preview', records: Array.from(previewSet) },
  ].filter((column) => column.records.length);

  const visibleRecordNames = new Set(visibleColumns.flatMap((column) => column.records));
  const nodesByRecord = new Map(
    layout.layers.flatMap((layer) => layer.nodes.map((node) => [node.recordName, node]))
  );

  const nodes = visibleColumns.flatMap((column, columnIndex) =>
    column.records
      .map((recordName) => nodesByRecord.get(recordName))
      .filter(Boolean)
      .sort((left, right) => left.position.y - right.position.y)
      .map((node, rowIndex) => {
        const tone = categoryColor(node.category);
        return {
          id: node.recordName,
          type: 'recordNode',
          position: {
            x: 72 + columnIndex * 336,
            y: 84 + rowIndex * 214,
          },
          draggable: false,
          selectable: false,
          data: {
            node,
            state: stateMap.get(node.recordName) || 'preview',
            tone,
            favorite: favorites.includes(node.recordName),
            onInspect: handlers.onInspect,
            onToggle: handlers.onToggle,
            onPin: handlers.onPin,
            onOpenDocs: handlers.onOpenDocs,
          },
        };
      })
  );

  const edges = layout.edges
    .filter((edge) => visibleRecordNames.has(edge.source) && visibleRecordNames.has(edge.target))
    .map((edge) => {
      const active =
        pendingSelection.includes(edge.target) ||
        lockedLevels.some((level, index) => index > 0 && level.includes(edge.target));

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        selectable: false,
        focusable: false,
        animated: active,
        style: {
          stroke: active ? 'rgba(76, 104, 255, 0.72)' : 'rgba(96, 108, 136, 0.28)',
          strokeWidth: active ? 2.4 : 1.3,
        },
      };
    });

  return { nodes, edges, previewTargets: Array.from(previewSet) };
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

function RecordOverlay({
  record,
  state,
  favorite,
  canQueue,
  activeQuery,
  transformRequests,
  copyState,
  onClose,
  onCopy,
  onOpenDocs,
  onPin,
  onToggleQueue,
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
            tooltip="Close this record overlay"
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
          <span className="workflow-mini-pill">{state}</span>
        </div>

        <div className="workflow-overlay-actions">
          {canQueue ? (
            <TooltipButton
              className="workflow-overlay-action is-primary"
              tooltip={state === 'queued' ? 'Remove this branch from the queued next step' : 'Queue this branch for the next lock'}
              onClick={() => onToggleQueue(record.recordName)}
            >
              {state === 'queued' ? 'Remove from queue' : 'Queue next branch'}
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
            tooltip="Copy the current GET query for Postman"
            onClick={() => onCopy(activeQuery.url, 'Active query')}
          >
            Copy active query
          </TooltipButton>
        </div>

        <div className="workflow-overlay-grid">
          <section className="workflow-overlay-panel">
            <span className="workflow-overlay-label">Active query</span>
            <pre>{`${activeQuery.method} ${activeQuery.url}`}</pre>
            <p className="muted">GET requests do not require a request body.</p>
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
                  No upstream transform is required for this base record yet. Inspect a downstream node to see
                  the route-specific transform endpoints.
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

function RecordNode({ data }) {
  const { node, state, tone, favorite, onInspect, onToggle, onPin, onOpenDocs } = data;
  const canQueue = state === 'preview' || state === 'queued';

  return (
    <div
      className={`workflow-node-shell is-${state}`}
      style={{ '--node-accent': tone.accent, '--node-surface': tone.surface }}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <TooltipButton
        className="workflow-node-button"
        tooltip="Open endpoint details for this record"
        onClick={() => onInspect(node.recordName)}
      >
        <span className="workflow-node-heading">
          <span className="workflow-node-title">{node.title}</span>
          <span className="workflow-node-category">{node.categoryLabel}</span>
        </span>
        <span className="workflow-pill-row">
          <span className="workflow-stat-pill">{node.stats.operations} endpoints</span>
          <span className="workflow-stat-pill">{node.stats.outgoingTransforms} outgoing</span>
          <span className="workflow-stat-pill">{node.stats.incomingTransforms} incoming</span>
        </span>
        <span className="workflow-node-summary">{node.summary}</span>
        <span className="workflow-node-state">
          {state === 'base' && 'Base object'}
          {state === 'locked' && 'Locked branch'}
          {state === 'queued' && 'Queued for lock'}
          {state === 'preview' && 'Preview branch'}
          {state === 'dimmed' && 'Cached downstream object'}
        </span>
      </TooltipButton>
      <div className="workflow-node-actions">
        {canQueue ? (
          <TooltipButton
            className="workflow-node-action"
            tooltip={state === 'queued' ? 'Remove this branch from the next lock' : 'Queue this branch for the next lock'}
            onClick={() => onToggle(node.recordName)}
          >
            {state === 'queued' ? 'Queued' : 'Queue'}
          </TooltipButton>
        ) : null}
        <TooltipButton
          className="workflow-node-action"
          tooltip="Open the record docs in a new tab"
          onClick={() => onOpenDocs(node.docsPath)}
        >
          Open docs
        </TooltipButton>
        <TooltipButton
          className="workflow-node-action"
          tooltip={favorite ? 'Unpin this record from favorites' : 'Pin this record to favorites'}
          onClick={() => onPin(node.recordName)}
        >
          {favorite ? 'Pinned' : 'Pin'}
        </TooltipButton>
      </div>
      <Handle type="source" position={Position.Right} className="workflow-handle" />
    </div>
  );
}

const nodeTypes = {
  recordNode: RecordNode,
};

export function WorkflowStudio({ workflowIndex, initialWorkflow, initialBaseSlug }) {
  const [workflowMap, setWorkflowMap] = useState(() => new Map([[initialWorkflow.slug, initialWorkflow]]));
  const [loadingBase, setLoadingBase] = useState(null);
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
  const initialState = useMemo(() => {
    const parsed =
      typeof window === 'undefined' ? null : parseShareQuery(window.location.search, workflowIndex);
    const initialRecord =
      findRecordByName(workflowIndex, initialWorkflow.baseRecord) || findRecordBySlug(workflowIndex, initialBaseSlug);

    if (parsed) {
      return {
        baseRecord: parsed.baseRecord,
        baseSlug: parsed.baseSlug,
        lockedLevels: parsed.lockedLevels.length ? parsed.lockedLevels : [[parsed.baseRecord]],
      };
    }

    return {
      baseRecord: initialRecord?.recordName || initialWorkflow.baseRecord,
      baseSlug: initialRecord?.slug || initialWorkflow.slug || initialBaseSlug,
      lockedLevels: [[initialRecord?.recordName || initialWorkflow.baseRecord || initialBaseSlug]],
    };
  }, [initialBaseSlug, initialWorkflow.baseRecord, initialWorkflow.slug, workflowIndex]);

  const [state, setState] = useState(initialState);
  const [pendingSelection, setPendingSelection] = useState([]);
  const [overlayRecordName, setOverlayRecordName] = useState(null);
  const [copyState, setCopyState] = useState('');
  const graphRef = useRef(null);
  const currentWorkflow = workflowMap.get(state.baseSlug) || null;
  const recordCatalog = useMemo(() => buildRecordCatalog(workflowMap, workflowIndex), [workflowMap, workflowIndex]);
  function resolveRecord(recordName) {
    return (
      recordCatalog.get(recordName) ||
      findRecordByName(workflowIndex, recordName) ||
      findRecordBySlug(workflowIndex, recordName)
    );
  }
  const activeRecord = useMemo(
    () => findRecordByName(workflowIndex, state.baseRecord) || findRecordBySlug(workflowIndex, state.baseSlug),
    [state.baseRecord, state.baseSlug, workflowIndex]
  );
  const activeBaseSlug = activeRecord?.slug || state.baseSlug || initialBaseSlug;

  useEffect(() => {
    ensureWorkflow(state.baseSlug).catch((error) => {
      console.error(error);
      setLoadingBase(null);
    });
  }, [state.baseSlug]);

  useEffect(() => {
    if (!currentWorkflow) {
      return;
    }

    setState((current) => {
      const nextBaseRecord = currentWorkflow.baseRecord;
      const firstLocked = current.lockedLevels[0]?.[0];

      if (current.baseRecord === nextBaseRecord && firstLocked === nextBaseRecord) {
        return current;
      }

      const normalizedLevels = current.lockedLevels.map((level, index) =>
        index === 0 ? [nextBaseRecord] : level
      );

      return {
        ...current,
        baseRecord: nextBaseRecord,
        lockedLevels: normalizedLevels,
      };
    });
  }, [currentWorkflow]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('netsuite-docs:favorites', JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const query = buildShareQuery(activeBaseSlug || state.baseRecord, state.lockedLevels);
    window.history.replaceState({}, '', `${window.location.pathname}?${query}`);
  }, [activeBaseSlug, state]);

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
      translateY: [22, 0],
      scale: [0.985, 1],
      delay: stagger(26),
      duration: 420,
      ease: 'out(3)',
    });
  }, [currentWorkflow, state.lockedLevels, pendingSelection]);

  useEffect(() => {
    if (!copyState) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setCopyState(''), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  useEffect(() => {
    if (!overlayRecordName) {
      return;
    }

    const visibleNow = new Set([
      ...state.lockedLevels.flat(),
      ...buildPreviewTargets(currentWorkflow || initialWorkflow, state.lockedLevels),
    ]);

    if (!visibleNow.has(overlayRecordName)) {
      setOverlayRecordName(null);
    }
  }, [currentWorkflow, initialWorkflow, overlayRecordName, state.lockedLevels]);

  async function ensureWorkflow(slug) {
    if (workflowMap.has(slug)) {
      return workflowMap.get(slug);
    }

    setLoadingBase(slug);
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
    setLoadingBase(null);
    return payload;
  }

  async function handleBaseChange(event) {
    const nextSlug = event.currentTarget.value;
    const nextRecord = findRecordBySlug(workflowIndex, nextSlug);

    await ensureWorkflow(nextSlug);
    setPendingSelection([]);
    setOverlayRecordName(null);
    setState({
      baseRecord: nextRecord?.recordName || nextSlug,
      baseSlug: nextSlug,
      lockedLevels: [[nextRecord?.recordName || nextSlug]],
    });
  }

  function handleInspect(recordName) {
    setOverlayRecordName(recordName);
  }

  function handleToggle(recordName) {
    if (!currentWorkflow) {
      return;
    }

    const previewTargets = new Set(buildPreviewTargets(currentWorkflow, state.lockedLevels));
    if (!previewTargets.has(recordName)) {
      return;
    }

    setPendingSelection((current) =>
      current.includes(recordName)
        ? current.filter((item) => item !== recordName)
        : [...current, recordName]
    );
  }

  function handleCommit() {
    if (!pendingSelection.length) {
      return;
    }

    setState((current) => ({
      ...current,
      lockedLevels: [...current.lockedLevels, pendingSelection],
    }));
    setPendingSelection([]);
  }

  function handleBack() {
    if (pendingSelection.length) {
      setPendingSelection([]);
      return;
    }

    setState((current) => {
      if (current.lockedLevels.length === 1) {
        return current;
      }

      return {
        ...current,
        lockedLevels: current.lockedLevels.slice(0, -1),
      };
    });
  }

  function handleReset() {
    setPendingSelection([]);
    setOverlayRecordName(null);
    setState((current) => ({
      ...current,
      lockedLevels: [[current.baseRecord]],
    }));
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

  const nodeState = useMemo(
    () =>
      currentWorkflow
        ? buildNodeStateMap(currentWorkflow, state.lockedLevels, pendingSelection)
        : { stateMap: new Map(), previewSet: new Set() },
    [currentWorkflow, pendingSelection, state.lockedLevels]
  );

  const graph = useMemo(
    () =>
      currentWorkflow
        ? buildFlowGraph(currentWorkflow, state.lockedLevels, pendingSelection, favorites, {
            onInspect: handleInspect,
            onToggle: handleToggle,
            onPin: handlePin,
            onOpenDocs: handleOpenDocs,
          }, nodeState)
        : { nodes: [], edges: [], previewTargets: [] },
    [currentWorkflow, favorites, nodeState, pendingSelection, state.lockedLevels]
  );

  const shareQuery = useMemo(
    () => buildShareQuery(activeBaseSlug || state.baseRecord, state.lockedLevels),
    [activeBaseSlug, state.baseRecord, state.lockedLevels]
  );

  const atomicConfig = useMemo(
    () =>
      currentWorkflow
        ? buildAtomicConfig(currentWorkflow, state.baseRecord, state.lockedLevels)
        : null,
    [currentWorkflow, state.baseRecord, state.lockedLevels]
  );

  const previewRecords = useMemo(
    () => graph.previewTargets.map((recordName) => resolveRecord(recordName)).filter(Boolean),
    [graph.previewTargets, recordCatalog]
  );

  const favoritesMeta = useMemo(
    () => favorites.map((recordName) => resolveRecord(recordName)).filter(Boolean),
    [favorites, recordCatalog]
  );

  const lockedPath = useMemo(
    () =>
      state.lockedLevels.map((level) =>
        level.map((recordName) => resolveRecord(recordName)?.title || recordName)
      ),
    [state.lockedLevels, recordCatalog]
  );

  const inspectedRecordName =
    overlayRecordName || state.lockedLevels[state.lockedLevels.length - 1]?.[0] || state.baseRecord;
  const activeQuery = useMemo(
    () => (inspectedRecordName ? buildRecordRequest(inspectedRecordName) : null),
    [inspectedRecordName]
  );

  const overlayRecord = useMemo(
    () => (overlayRecordName ? resolveRecord(overlayRecordName) : null),
    [overlayRecordName, recordCatalog]
  );
  const overlayRouteStages = useMemo(
    () =>
      currentWorkflow && overlayRecordName
        ? collectInspectionRoute(currentWorkflow, state.lockedLevels, overlayRecordName)
        : [],
    [currentWorkflow, overlayRecordName, state.lockedLevels]
  );
  const overlayTransformRequests = useMemo(
    () => buildImmediateTransformRequests(overlayRecord, resolveRecord, overlayRouteStages),
    [overlayRecord, overlayRouteStages, recordCatalog]
  );
  const overlayState = overlayRecordName ? nodeState.stateMap.get(overlayRecordName) || 'base' : null;

  return (
    <section className="workflow-studio-route">
      <header className="workflow-hero-card">
        <div className="workflow-hero-copy">
          <p className="workflow-kicker">Workflow Studio</p>
          <h1>{activeRecord?.title || currentWorkflow?.baseRecord || initialWorkflow.baseRecord} transform atlas</h1>
          <p>
            Inspect any visible record card to open the route overlay, copy the active GET query, and review the
            exact transform endpoints that lead into that object.
          </p>
          <div className="workflow-pill-row">
            <span className="workflow-mini-pill is-tinted">
              {currentWorkflow?.layers.length || 0} cached layers
            </span>
            <span className="workflow-mini-pill is-tinted">
              {currentWorkflow?.edges.length || 0} transform edges
            </span>
            <span className="workflow-mini-pill is-tinted">
              {graph.previewTargets.length} preview options
            </span>
          </div>
        </div>

        <div className="workflow-toolbar-card">
          <label className="workflow-select-label">
            <span>Base object</span>
            <select value={activeBaseSlug} onChange={handleBaseChange}>
              {workflowIndex.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.title} ({item.outgoingTransforms} transforms)
                </option>
              ))}
            </select>
          </label>

          <div className="workflow-toolbar-actions">
            <TooltipButton
              tooltip="Commit the queued preview branches into the next locked level"
              onClick={handleCommit}
              disabled={pendingSelection.length === 0 || !currentWorkflow}
            >
              Lock selected
            </TooltipButton>
            <TooltipButton
              tooltip="Step back one level, or clear the current queued branch list first"
              onClick={handleBack}
              disabled={pendingSelection.length === 0 && state.lockedLevels.length === 1}
            >
              Back
            </TooltipButton>
            <TooltipButton
              tooltip="Reset the route back to the base object"
              onClick={handleReset}
              disabled={!currentWorkflow}
            >
              Reset
            </TooltipButton>
          </div>

          <div className="workflow-legend-row">
            <span className="workflow-legend-item">
              <i className="tone-base" />
              base
            </span>
            <span className="workflow-legend-item">
              <i className="tone-preview" />
              preview
            </span>
            <span className="workflow-legend-item">
              <i className="tone-locked" />
              locked
            </span>
            <span className="workflow-legend-item">
              <i className="tone-queued" />
              queued
            </span>
          </div>
        </div>
      </header>

      <div className="workflow-layout-shell">
        <div className="workflow-graph-stage" ref={graphRef}>
          {currentWorkflow ? (
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.14, maxZoom: 1.06 }}
              minZoom={0.58}
              maxZoom={1.36}
              panOnScroll
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(96, 108, 136, 0.13)" gap={28} />
              <Controls showInteractive={false} />
              <Panel position="top-left" className="workflow-stage-note">
                {loadingBase ? `Loading ${loadingBase}...` : `${graph.nodes.length} rendered nodes from cached vectors`}
              </Panel>
            </ReactFlow>
          ) : (
            <div className="workflow-loading-state">
              <strong>Loading cached workflow map…</strong>
              <span>Each base record is fetched from a prebuilt vector payload only when you open it.</span>
            </div>
          )}
        </div>

        <aside className="workflow-side-rail">
          <section className="workflow-rail-card">
            <h2>Selection</h2>
            <p className="muted">Queued branches become the next locked level when committed.</p>
            <div className="workflow-pill-stack">
              {pendingSelection.length ? (
                pendingSelection.map((recordName) => {
                  const record = resolveRecord(recordName);
                  return <span className="workflow-mini-pill" key={recordName}>{record?.title || recordName}</span>;
                })
              ) : (
                <span className="muted">Use Queue on any preview card, or inspect a card to review its endpoint path.</span>
              )}
            </div>
          </section>

          <section className="workflow-rail-card">
            <h2>Preview frontier</h2>
            <div className="workflow-pill-stack">
              {previewRecords.length ? (
                previewRecords.map((record) => (
                  <span className="workflow-mini-pill is-category" key={record.recordName}>
                    {record.title}
                  </span>
                ))
              ) : (
                <span className="muted">No more outgoing transforms from the current lock.</span>
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
                <span className="muted">Pin records directly from the graph.</span>
              )}
            </div>
          </section>

          <section className="workflow-rail-card">
            <h2>Locked path</h2>
            <div className="workflow-path-stack">
              {lockedPath.map((level, index) => (
                <div className="workflow-path-row" key={`level-${index}`}>
                  <span className="workflow-path-step">L{index}</span>
                  <div className="workflow-pill-stack">
                    {level.map((label) => (
                      <span className="workflow-mini-pill" key={label}>{label}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="workflow-rail-card">
            <h2>Share query</h2>
            <pre>{`?${shareQuery}`}</pre>
            <TooltipButton
              tooltip="Copy the studio share query from the current locked route"
              onClick={() => handleCopy(`?${shareQuery}`, 'Share query')}
            >
              Copy query
            </TooltipButton>
          </section>

          <section className="workflow-rail-card">
            <h2>Postman active query</h2>
            <pre>{activeQuery ? `${activeQuery.method} ${activeQuery.url}` : 'Loading...'}</pre>
            <p className="muted">GET requests do not require body data.</p>
            <TooltipButton
              tooltip="Copy the current GET query for the focused record"
              onClick={() => activeQuery && handleCopy(activeQuery.url, 'Active query')}
              disabled={!activeQuery}
            >
              Copy active query
            </TooltipButton>
          </section>

          <section className="workflow-rail-card">
            <h2>Atomic config</h2>
            <pre>{atomicConfig ? JSON.stringify(atomicConfig, null, 2) : 'Loading...'}</pre>
            <TooltipButton
              tooltip="Copy the atomic route configuration"
              onClick={() => atomicConfig && handleCopy(JSON.stringify(atomicConfig, null, 2), 'Atomic config')}
              disabled={!atomicConfig}
            >
              Copy config
            </TooltipButton>
            {copyState ? <p className="workflow-copy-note">{copyState}</p> : null}
          </section>
        </aside>
      </div>

      {overlayRecord && activeQuery ? (
        <RecordOverlay
          record={overlayRecord}
          state={overlayState}
          favorite={favorites.includes(overlayRecord.recordName)}
          canQueue={overlayState === 'preview' || overlayState === 'queued'}
          activeQuery={buildRecordRequest(overlayRecord.recordName)}
          transformRequests={overlayTransformRequests}
          copyState={copyState}
          onClose={() => setOverlayRecordName(null)}
          onCopy={handleCopy}
          onOpenDocs={handleOpenDocs}
          onPin={handlePin}
          onToggleQueue={handleToggle}
        />
      ) : null}
    </section>
  );
}

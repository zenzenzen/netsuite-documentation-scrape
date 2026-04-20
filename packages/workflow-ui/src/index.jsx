import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(query);
    const handleChange = (event) => setMatches(event.matches);

    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
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

function getNodeMap(layout) {
  return new Map(layout.layers.flatMap((layer) => layer.nodes.map((node) => [node.recordName, node])));
}

function getEdge(layout, source, target) {
  return layout.edges.find((edge) => edge.source === source && edge.target === target) || null;
}

function getOutgoingNodes(layout, recordName) {
  const nodeMap = getNodeMap(layout);
  return layout.edges
    .filter((edge) => edge.source === recordName)
    .map((edge) => nodeMap.get(edge.target))
    .filter(Boolean);
}

function normalizeSelectedPath(layout, requestedPath) {
  if (!layout || !requestedPath.length) {
    return [];
  }

  const normalized = [layout.baseRecord];
  let previous = layout.baseRecord;

  for (const recordName of requestedPath.slice(1)) {
    if (!getEdge(layout, previous, recordName)) {
      break;
    }

    normalized.push(recordName);
    previous = recordName;
  }

  return normalized;
}

function buildImmediateTransformRequests(layout, selectedPath, recordName, resolveRecord) {
  if (!layout || !recordName) {
    return [];
  }

  const latestSelected = selectedPath[selectedPath.length - 1] || null;

  if (recordName === latestSelected && selectedPath.length > 1) {
    const source = selectedPath[selectedPath.length - 2];
    const transform = getEdge(layout, source, recordName);

    if (!transform) {
      return [];
    }

    const sourceRecord = resolveRecord(source);
    const targetRecord = resolveRecord(recordName);

    return [
      {
        id: transform.id,
        label: `${sourceRecord?.title || source} -> ${targetRecord?.title || recordName}`,
        summary: transform.summary,
        request: buildTransformRequest(transform),
      },
    ];
  }

  if (latestSelected) {
    const transform = getEdge(layout, latestSelected, recordName);
    if (transform) {
      const sourceRecord = resolveRecord(latestSelected);
      const targetRecord = resolveRecord(recordName);

      return [
        {
          id: transform.id,
          label: `${sourceRecord?.title || latestSelected} -> ${targetRecord?.title || recordName}`,
          summary: transform.summary,
          request: buildTransformRequest(transform),
        },
      ];
    }
  }

  return (resolveRecord(recordName)?.endpoints || [])
    .filter((endpoint) => endpoint.isTransform)
    .map((endpoint) => {
      const targetName = endpoint.path.split('/!transform/')[1] || endpoint.path;
      const targetRecord = resolveRecord(targetName);
      const transform = {
        id: `${recordName}:${endpoint.path}`,
        source: recordName,
        target: targetRecord?.recordName || targetName,
        path: endpoint.path,
        method: endpoint.method,
        summary: endpoint.summary,
      };

      return {
        id: transform.id,
        label: `${resolveRecord(recordName)?.title || recordName} -> ${targetRecord?.title || transform.target}`,
        summary: transform.summary,
        request: buildTransformRequest(transform),
      };
    });
}

function buildFocusedGraph(layout, selectedPath, favorites, focusedRecordName, handlers = {}) {
  const nodeMap = getNodeMap(layout);
  const latestSelected = selectedPath[selectedPath.length - 1] || layout.baseRecord;
  const frontier = sortByTitle(getOutgoingNodes(layout, latestSelected));

  const pathNodes = selectedPath
    .map((recordName) => nodeMap.get(recordName))
    .filter(Boolean)
    .map((node, index) => {
      const tone = categoryColor(node.category || 'other');

      return {
        id: node.recordName,
        type: 'recordNode',
        position: {
          x: index * 312,
          y: 0,
        },
        draggable: false,
        selectable: false,
        style: { pointerEvents: 'all' },
        data: {
          record: node,
          mode: 'focus',
          state:
            index === 0
              ? 'anchor'
              : index === selectedPath.length - 1
                ? 'selected'
                : 'path',
          favorite: favorites.includes(node.recordName),
          focused: focusedRecordName === node.recordName,
          tone,
          canAdvance: false,
          canFocus: true,
          canInspect: true,
          canUndoLatest: index === selectedPath.length - 1 && selectedPath.length > 1,
          onAdvance: handlers.onAdvance,
          onFocusRecord: handlers.onFocusRecord,
          onInspect: handlers.onInspect,
          onUndoLatest: handlers.onUndoLatest,
        },
      };
    });

  const frontierNodes = frontier.map((node, index) => {
    const count = Math.max(1, frontier.length);
    const spread = count > 1 ? count - 1 : 1;
    const offset = (hashString(node.recordName) % 26) - 13;
    const tone = categoryColor(node.category || 'other');

    return {
      id: node.recordName,
      type: 'recordNode',
      position: {
        x: selectedPath.length * 312,
        y: Math.round((index - spread / 2) * 138 + offset),
      },
      draggable: false,
      selectable: false,
      style: { pointerEvents: 'all' },
      data: {
        record: node,
        mode: 'focus',
        state: 'frontier',
        favorite: favorites.includes(node.recordName),
        focused: focusedRecordName === node.recordName,
        tone,
        canAdvance: true,
        canFocus: false,
        canInspect: true,
        canUndoLatest: false,
        onAdvance: handlers.onAdvance,
        onFocusRecord: handlers.onFocusRecord,
        onInspect: handlers.onInspect,
        onUndoLatest: handlers.onUndoLatest,
      },
    };
  });

  const edges = [];

  for (let index = 1; index < selectedPath.length; index += 1) {
    const transform = getEdge(layout, selectedPath[index - 1], selectedPath[index]);
    if (!transform) {
      continue;
    }

    edges.push({
      id: transform.id,
      source: transform.source,
      target: transform.target,
      type: 'smoothstep',
      selectable: false,
      focusable: false,
      animated: true,
      style: {
        stroke: 'rgba(20, 143, 136, 0.86)',
        strokeWidth: 2.5,
      },
    });
  }

  for (const node of frontier) {
    const transform = getEdge(layout, latestSelected, node.recordName);
    if (!transform) {
      continue;
    }

    edges.push({
      id: transform.id,
      source: transform.source,
      target: transform.target,
      type: 'smoothstep',
      selectable: false,
      focusable: false,
      animated: false,
      style: {
        stroke: 'rgba(76, 104, 255, 0.44)',
        strokeWidth: 1.6,
      },
    });
  }

  return {
    nodes: [...pathNodes, ...frontierNodes],
    edges,
    latestSelected,
    frontier,
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

function NodeActionMenu({
  record,
  canInspect,
  canUndoLatest,
  onInspect,
  onUndoLatest,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`workflow-node-menu${open ? ' is-open' : ''}`} ref={menuRef}>
      <button
        type="button"
        className="workflow-node-menu-trigger"
        aria-label={`More actions for ${record.title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        ⋯
      </button>

      {open ? (
        <div className="workflow-node-menu-popover">
          {canInspect ? (
            <button
              type="button"
              className="workflow-node-menu-item"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onInspect(record.recordName);
                setOpen(false);
              }}
            >
              Open inspector
            </button>
          ) : null}
          {canUndoLatest ? (
            <button
              type="button"
              className="workflow-node-menu-item"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onUndoLatest();
                setOpen(false);
              }}
            >
              Step back
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RecordPill({
  record,
  mode,
  state,
  favorite,
  focused,
  tone,
  canAdvance,
  canFocus,
  canInspect,
  canUndoLatest,
  onAdvance,
  onFocusRecord,
  onInspect,
  onUndoLatest,
}) {
  const primaryTooltip =
    mode === 'catalog'
      ? 'Anchor workflow on this object'
      : canAdvance
        ? 'Extend the path with this node'
        : canFocus
          ? 'Refocus the query card on this node'
          : 'Use the menu for more actions';

  return (
    <div
      className={`workflow-node-shell is-${mode} is-${state}${favorite ? ' is-favorite' : ''}${
        focused ? ' is-focused' : ''
      }`}
      style={{ '--node-accent': tone.accent, '--node-surface': tone.surface }}
    >
      <NodeActionMenu
        record={record}
        canInspect={canInspect}
        canUndoLatest={canUndoLatest}
        onInspect={onInspect}
        onUndoLatest={onUndoLatest}
      />
      {mode === 'focus' ? <Handle type="target" position={Position.Left} className="workflow-handle" /> : null}
      <TooltipButton
        className={`workflow-node-button${canAdvance || canFocus ? ' is-advance' : ' is-static'}`}
        tooltip={primaryTooltip}
        aria-label={primaryTooltip}
        aria-pressed={canFocus && focused ? 'true' : undefined}
        onClick={() => {
          if (canAdvance) {
            onAdvance(record.recordName);
            return;
          }

          if (canFocus) {
            onFocusRecord(record.recordName);
          }
        }}
      >
        <span className="workflow-node-title">{record.title}</span>
      </TooltipButton>
      {mode === 'focus' ? <Handle type="source" position={Position.Right} className="workflow-handle" /> : null}
    </div>
  );
}

function RecordNode({ data }) {
  return <RecordPill {...data} />;
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
  const stats = record.stats || {
    operations: 0,
    outgoingTransforms: 0,
    incomingTransforms: 0,
  };
  const dependencyCount = record.dependencies?.length || 0;
  const docsPath = record.docsPath || `./records/${record.slug || record.recordName}.html`;

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
            <p className="workflow-overlay-summary">
              Inspect this object, its active GET request, and the immediate transform route into it.
            </p>
          </div>
          <TooltipButton
            className="workflow-overlay-close"
            tooltip="Close the inspector"
            aria-label="Close inspector"
            onClick={onClose}
          >
            ×
          </TooltipButton>
        </div>

        <div className="workflow-overlay-scroll">
          <div className="workflow-pill-row">
            <span className="workflow-mini-pill is-tinted">{record.categoryLabel}</span>
            <span className="workflow-mini-pill">Endpoints: {stats.operations}</span>
            <span className="workflow-mini-pill">Transforms: {stats.outgoingTransforms}</span>
            <span className="workflow-mini-pill">Dependencies: {dependencyCount}</span>
            {anchorRecord?.recordName === record.recordName ? (
              <span className="workflow-mini-pill">Current anchor</span>
            ) : null}
          </div>

          <div className="workflow-overlay-actions">
            {anchorRecord?.recordName !== record.recordName ? (
              <TooltipButton
                className="workflow-overlay-action is-primary"
                tooltip="Restart the workflow with this object as the anchor"
                onClick={() => onAnchor(record.recordName)}
              >
                Use as anchor
              </TooltipButton>
            ) : null}
            <TooltipButton
              className="workflow-overlay-action"
              tooltip="Open the record documentation in a new tab"
              onClick={() => onOpenDocs(docsPath)}
            >
              Open docs
            </TooltipButton>
            <a
              className="workflow-overlay-action"
              href={`https://system.netsuite.com/help/helpcenter/en_US/APIs/REST_API_Browser/record/v1/2023.1/index.html#section/${record.recordName}`}
              target="_blank"
              rel="noopener noreferrer"
              title="View this record in the NetSuite REST API Browser"
            >
              NetSuite docs ↗
            </a>
            <TooltipButton
              className="workflow-overlay-action"
              tooltip={favorite ? 'Unpin this record from favorites' : 'Pin this record to favorites'}
              onClick={() => onPin(record.recordName)}
            >
              {favorite ? 'Unpin record' : 'Pin record'}
            </TooltipButton>
          </div>

          <div className="workflow-overlay-grid">
            <section className="workflow-overlay-panel">
              <span className="workflow-overlay-label">Active query</span>
              <CodeBlock
                value={`${activeQuery.method} ${activeQuery.url}`}
                label="Copy active query"
                onCopy={() => onCopy(`${activeQuery.method} ${activeQuery.url}`, 'Active query')}
              />
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
                      <CodeBlock
                        value={`${item.request.method} ${item.request.url}`}
                        label={`Copy ${item.label}`}
                        onCopy={() => onCopy(`${item.request.method} ${item.request.url}`, item.label)}
                      />
                    </article>
                  ))
                ) : (
                  <p className="muted">
                    No immediate transform is required for this object yet. Pick a downstream node to reveal its exact
                    transform request.
                  </p>
                )}
              </div>
            </section>
          </div>

          {copyState ? <p className="workflow-copy-note">{copyState}</p> : null}
        </div>
      </section>
    </div>,
    document.body
  );
}

function CodeBlock({ value, label, onCopy }) {
  return (
    <div className="workflow-code-block">
      <pre>{value}</pre>
      <TooltipButton className="workflow-code-copy" tooltip={label} onClick={onCopy} aria-label={label}>
        Copy
      </TooltipButton>
    </div>
  );
}

function CatalogGrid({ workflowIndex, favorites, onAnchor, onInspect }) {
  return (
    <div className="workflow-catalog-grid">
      {sortByTitle(workflowIndex).map((record) => {
        const tone = categoryColor(record.category || 'other');
        return (
          <RecordPill
            key={record.recordName}
            record={record}
            mode="catalog"
            state="catalog"
            favorite={favorites.includes(record.recordName)}
            tone={tone}
            canAdvance
            canInspect
            canUndoLatest={false}
            onAdvance={onAnchor}
            onInspect={onInspect}
            onUndoLatest={() => {}}
          />
        );
      })}
    </div>
  );
}

function GraphActionButton({ tooltip, children, ...props }) {
  return (
    <TooltipButton className="workflow-graph-action" tooltip={tooltip} {...props}>
      {children}
    </TooltipButton>
  );
}

function FrontierPillList({ records, onAdvance }) {
  const listRef = useRef(null);

  function handleArrowNavigation(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      return;
    }

    const buttons = [...(listRef.current?.querySelectorAll('[data-frontier-pill]') || [])];
    const currentIndex = buttons.indexOf(event.currentTarget);

    if (currentIndex === -1 || !buttons.length) {
      return;
    }

    event.preventDefault();
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  return (
    <div className="workflow-pill-stack" ref={listRef}>
      {records.map((record) => (
        <button
          type="button"
          className="workflow-mini-pill workflow-frontier-pill is-category"
          key={record.recordName}
          data-frontier-pill
          onClick={() => onAdvance(record.recordName)}
          onKeyDown={handleArrowNavigation}
        >
          {record.title}
        </button>
      ))}
    </div>
  );
}

export function WorkflowStudio({ workflowIndex }) {
  const [workflowMap, setWorkflowMap] = useState(() => new Map());
  const [selectedPath, setSelectedPath] = useState(() => {
    if (typeof window === 'undefined') {
      return [];
    }

    const parsed = parseShareQuery(window.location.search, workflowIndex);
    return parsed ? parsed.lockedLevels.flat() : [];
  });
  const [inspectionRecordName, setInspectionRecordName] = useState(null);
  const [focusedRecordName, setFocusedRecordName] = useState(null);
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
  const reactFlowInstanceRef = useRef(null);
  const fitViewFrameRef = useRef(0);
  const previousNodeRectsRef = useRef(new Map());
  const isCompactViewport = useMediaQuery('(max-width: 767px)');
  const recordCatalog = useMemo(() => buildRecordCatalog(workflowMap, workflowIndex), [workflowMap, workflowIndex]);

  function resolveRecord(recordName) {
    return (
      recordCatalog.get(recordName) ||
      findRecordByName(workflowIndex, recordName) ||
      findRecordBySlug(workflowIndex, recordName) ||
      null
    );
  }

  const anchorRecord = useMemo(
    () => (selectedPath.length ? resolveRecord(selectedPath[0]) : null),
    [selectedPath, recordCatalog]
  );
  const currentWorkflow = useMemo(
    () => (anchorRecord?.slug ? workflowMap.get(anchorRecord.slug) || null : null),
    [anchorRecord, workflowMap]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (anchorRecord?.slug) {
      const query = buildShareQuery(
        anchorRecord.slug,
        selectedPath.map((recordName) => [recordName])
      );
      window.history.replaceState({}, '', `${window.location.pathname}?${query}`);
    } else {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [anchorRecord, selectedPath]);

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
    if (!currentWorkflow) {
      return;
    }

    const normalized = normalizeSelectedPath(currentWorkflow, selectedPath);
    if (normalized.join('|') !== selectedPath.join('|')) {
      setSelectedPath(normalized);
    }
  }, [currentWorkflow, selectedPath]);

  useEffect(() => {
    if (!inspectionRecordName || !currentWorkflow) {
      return;
    }

    const normalized = normalizeSelectedPath(currentWorkflow, selectedPath);
    const latestSelected = normalized[normalized.length - 1] || null;
    const visible = new Set(normalized);

    for (const node of getOutgoingNodes(currentWorkflow, latestSelected)) {
      visible.add(node.recordName);
    }

    if (!visible.has(inspectionRecordName)) {
      setInspectionRecordName(null);
    }
  }, [currentWorkflow, inspectionRecordName, selectedPath]);

  useEffect(() => {
    if (!graphRef.current || !reactFlowInstanceRef.current || !currentWorkflow || isCompactViewport) {
      return;
    }

    window.cancelAnimationFrame(fitViewFrameRef.current);
    fitViewFrameRef.current = window.requestAnimationFrame(() => {
      reactFlowInstanceRef.current?.fitView({
        padding: 0.24,
        maxZoom: 1.08,
        duration: 280,
      });
    });

    return () => window.cancelAnimationFrame(fitViewFrameRef.current);
  }, [currentWorkflow, isCompactViewport, selectedPath]);

  useEffect(() => {
    if (!anchorRecord || isCompactViewport || !reactFlowInstanceRef.current) {
      return undefined;
    }

    function handleResize() {
      window.cancelAnimationFrame(fitViewFrameRef.current);
      fitViewFrameRef.current = window.requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({
          padding: 0.24,
          maxZoom: 1.08,
          duration: 220,
        });
      });
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [anchorRecord, isCompactViewport]);

  useLayoutEffect(() => {
    if (!graphRef.current || !currentWorkflow || isCompactViewport) {
      previousNodeRectsRef.current = new Map();
      return;
    }

    const wrappers = [...graphRef.current.querySelectorAll('.react-flow__node[data-id]')];
    const currentRects = new Map(
      wrappers.map((wrapper) => [wrapper.getAttribute('data-id'), wrapper.getBoundingClientRect()])
    );
    const enteringNodes = [];

    for (const wrapper of wrappers) {
      const id = wrapper.getAttribute('data-id');
      const shell = wrapper.querySelector('.workflow-node-shell');

      if (!id || !shell) {
        continue;
      }

      const previousRect = previousNodeRectsRef.current.get(id);
      const nextRect = currentRects.get(id);

      if (previousRect && nextRect) {
        const deltaX = previousRect.left - nextRect.left;
        const deltaY = previousRect.top - nextRect.top;

        if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
          animate(shell, {
            translateX: [deltaX, 0],
            translateY: [deltaY, 0],
            duration: 300,
            ease: 'out(3)',
          });
        }
      } else {
        enteringNodes.push(shell);
      }
    }

    if (enteringNodes.length) {
      animate(enteringNodes, {
        opacity: [0, 1],
        scale: [0.98, 1],
        translateY: [12, 0],
        delay: stagger(22),
        duration: 260,
        ease: 'out(3)',
      });
    }

    previousNodeRectsRef.current = currentRects;
  }, [currentWorkflow, isCompactViewport, selectedPath]);

  useEffect(() => {
    if (!focusedRecordName || !currentWorkflow) {
      return;
    }

    const normalized = normalizeSelectedPath(currentWorkflow, selectedPath);
    const latestSelected = normalized[normalized.length - 1] || null;
    const visible = new Set(normalized);

    for (const node of getOutgoingNodes(currentWorkflow, latestSelected)) {
      visible.add(node.recordName);
    }

    if (!visible.has(focusedRecordName)) {
      setFocusedRecordName(null);
    }
  }, [currentWorkflow, focusedRecordName, selectedPath]);

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
    startTransition(() => {
      setInspectionRecordName(null);
      setFocusedRecordName(null);
      setSelectedPath([record.recordName]);
    });
  }

  function handleAdvance(recordName) {
    if (!currentWorkflow || !selectedPath.length) {
      return;
    }

    const latestSelected = selectedPath[selectedPath.length - 1];
    if (!getEdge(currentWorkflow, latestSelected, recordName)) {
      return;
    }

    startTransition(() => {
      setInspectionRecordName(null);
      setFocusedRecordName(null);
      setSelectedPath((current) => [...current, recordName]);
    });
  }

  function handleUndoLatest() {
    startTransition(() => {
      setInspectionRecordName(null);
      setFocusedRecordName(null);
      setSelectedPath((current) => (current.length > 1 ? current.slice(0, -1) : current));
    });
  }

  function handleBrowseAll() {
    startTransition(() => {
      setInspectionRecordName(null);
      setFocusedRecordName(null);
      setSelectedPath([]);
      setLoadingSlug(null);
    });
  }

  function handleInspect(recordName) {
    setFocusedRecordName(recordName);
    setInspectionRecordName(recordName);
  }

  function handleFocusRecord(recordName) {
    setFocusedRecordName(recordName);
  }

  function handlePin(recordName) {
    setFavorites((current) =>
      current.includes(recordName)
        ? current.filter((item) => item !== recordName)
        : [...current, recordName]
    );
  }

  function handleOpenDocs(docsPath) {
    const nextPath = String(docsPath || '')
      .replace(/^\.\//, '/')
      .replace(/^\/public\//, '/');
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
    if (!anchorRecord || !currentWorkflow || !selectedPath.length) {
      return null;
    }

    return buildFocusedGraph(currentWorkflow, selectedPath, favorites, focusedRecordName, {
      onAdvance: handleAdvance,
      onFocusRecord: handleFocusRecord,
      onInspect: handleInspect,
      onUndoLatest: handleUndoLatest,
    });
  }, [anchorRecord, currentWorkflow, favorites, focusedRecordName, selectedPath]);

  const latestSelectedName = selectedPath[selectedPath.length - 1] || null;
  const activeRecordName = focusedRecordName || latestSelectedName || null;
  const activeRecord = activeRecordName ? resolveRecord(activeRecordName) : null;
  const activeQuery = activeRecord ? buildRecordRequest(activeRecord.recordName) : null;
  const inspectionRecord = inspectionRecordName ? resolveRecord(inspectionRecordName) : null;
  const overlayTransformRequests = useMemo(
    () =>
      inspectionRecord && currentWorkflow
        ? buildImmediateTransformRequests(currentWorkflow, selectedPath, inspectionRecord.recordName, resolveRecord)
        : [],
    [currentWorkflow, inspectionRecord, recordCatalog, selectedPath]
  );
  const nextFrontier = useMemo(
    () => (graph?.frontier ? graph.frontier : []),
    [graph]
  );
  const favoritesMeta = useMemo(
    () => favorites.map((recordName) => resolveRecord(recordName)).filter(Boolean),
    [favorites, recordCatalog]
  );
  const latestSelected = latestSelectedName ? resolveRecord(latestSelectedName) : null;
  const heroTitle = anchorRecord ? `${anchorRecord.title} transform atlas` : 'Workflow Studio';
  const heroCopy = anchorRecord
    ? latestSelected && latestSelected.recordName !== anchorRecord.recordName
      ? `Scoped path: ${selectedPath.map((recordName) => resolveRecord(recordName)?.title || recordName).join(' -> ')}. Click a frontier node to extend the path, or click any visible node to refocus the query card.`
      : `Focused on ${anchorRecord.title}. Extend the path with any frontier node, or click a visible node to refocus the query card.`
    : 'Alphabetized object catalog. Pick a name to anchor the workflow, then click downstream pills to persist a visible path through the graph.';
  const stageNote = anchorRecord
    ? loadingSlug
      ? `Loading ${loadingSlug}...`
      : `Scoped graph for ${latestSelected?.title || anchorRecord.title}`
    : 'Alphabetized catalog. Pick any object to anchor the workflow.';
  const railPrompt = anchorRecord
    ? latestSelected?.recordName === anchorRecord.recordName
      ? `The first downstream layer shows the objects that can be created from ${anchorRecord.title}.`
      : `Latest path node: ${latestSelected?.title || latestSelectedName}. Click any visible node to refocus the query card, or use the menu to open the inspector.`
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
            <span className="workflow-anchor-label">{anchorRecord ? 'Anchor' : 'Catalog mode'}</span>
            <strong>{anchorRecord ? anchorRecord.title : `${workflowIndex.length} objects available`}</strong>
            <span className="muted">{railPrompt}</span>
          </div>
        </div>
      </header>

      <div className="workflow-layout-shell">
        <div className="workflow-graph-stage" ref={graphRef}>
          {anchorRecord ? (
            isCompactViewport ? (
              <div className="workflow-mobile-stage">
                <strong>Desktop graph hidden below 768px</strong>
                <p>
                  The graph layout is desktop-optimized, so the canvas is replaced here with list navigation. Use the
                  frontier buttons below to keep extending the path.
                </p>
                <div className="workflow-pill-stack">
                  {selectedPath.map((recordName) => {
                    const record = resolveRecord(recordName);
                    return (
                      <button
                        type="button"
                        className={`workflow-mini-pill workflow-frontier-pill${
                          activeRecordName === recordName ? ' is-active' : ''
                        }`}
                        key={recordName}
                        onClick={() => handleFocusRecord(recordName)}
                      >
                        {record?.title || recordName}
                      </button>
                    );
                  })}
                </div>
                <div className="workflow-stage-actions workflow-stage-actions-mobile">
                  <GraphActionButton tooltip="Step back one node" onClick={handleUndoLatest}>
                    Step back
                  </GraphActionButton>
                  <GraphActionButton
                    tooltip="Copy the current page link"
                    onClick={() => handleCopy(window.location.href, 'Page link')}
                  >
                    Copy link
                  </GraphActionButton>
                  <GraphActionButton tooltip="Reset back to the full object catalog" onClick={handleBrowseAll}>
                    Reset graph
                  </GraphActionButton>
                </div>
              </div>
            ) : currentWorkflow && graph ? (
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1.08 }}
                minZoom={0.54}
                maxZoom={1.42}
                panOnScroll
                panOnDrag
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
                onInit={(instance) => {
                  reactFlowInstanceRef.current = instance;
                }}
              >
                <Background color="rgba(96, 108, 136, 0.12)" gap={28} />
                <Controls showInteractive={false} />
                <Panel position="top-left" className="workflow-stage-note">
                  {stageNote}
                </Panel>
                <Panel position="top-right" className="workflow-stage-actions">
                  <GraphActionButton
                    tooltip="Copy the current page link"
                    onClick={() => handleCopy(window.location.href, 'Page link')}
                  >
                    Copy link
                  </GraphActionButton>
                  <GraphActionButton tooltip="Reset back to the full object catalog" onClick={handleBrowseAll}>
                    Reset graph
                  </GraphActionButton>
                </Panel>
              </ReactFlow>
            ) : (
              <div className="workflow-loading-state">
                <strong>Loading anchored workflow…</strong>
                <span>The scoped graph appears as soon as the cached workflow payload resolves.</span>
              </div>
            )
          ) : (
            <div className="workflow-catalog-stage">
              <div className="workflow-stage-note workflow-stage-note-static">{stageNote}</div>
              <div className="workflow-stage-meta workflow-stage-meta-static">
                <span>{workflowIndex.length} objects</span>
                <span>Alphabetized</span>
              </div>
              <CatalogGrid
                workflowIndex={workflowIndex}
                favorites={favorites}
                onAnchor={handleAnchor}
                onInspect={handleInspect}
              />
            </div>
          )}
        </div>

        <aside className="workflow-side-rail">
          <section className="workflow-rail-card">
            <h2>{anchorRecord ? 'Focused query' : 'Anchor prompt'}</h2>
            {activeQuery ? (
              <>
                <span className="workflow-active-record-label">{activeRecord?.title || activeRecordName}</span>
                <CodeBlock
                  value={`${activeQuery.method} ${activeQuery.url}`}
                  label="Copy the current GET query"
                  onCopy={() => handleCopy(`${activeQuery.method} ${activeQuery.url}`, 'Active query')}
                />
                <p className="muted">GET requests do not require request body data.</p>
                <div className="workflow-toolbar-actions">
                  {activeRecord ? (
                    <TooltipButton
                      tooltip="Open the inspector for this record"
                      onClick={() => handleInspect(activeRecord.recordName)}
                    >
                      Open inspector
                    </TooltipButton>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="muted">Pick an object from the catalog to anchor the workflow and reveal its query.</p>
            )}
          </section>

          <section className="workflow-rail-card">
            <h2>Next frontier</h2>
            <p className="muted">Choose a frontier record to extend the path.</p>
            <div>
              {anchorRecord ? (
                nextFrontier.length ? (
                  <FrontierPillList records={nextFrontier} onAdvance={handleAdvance} />
                ) : (
                  <span className="muted">No further transforms from this selected node.</span>
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
                <span className="muted">Pin records from the inspector to keep them close.</span>
              )}
            </div>
          </section>

          <section className="workflow-rail-card">
            <h2>Visual key</h2>
            <div className="workflow-legend-stack">
              <span className="workflow-legend-item">
                <i className="tone-base" />
                Warm-toned nodes show the anchor and locked route.
              </span>
              <span className="workflow-legend-item">
                <i className="tone-preview" />
                Blue pills and nodes are the next frontier.
              </span>
              <span className="workflow-legend-item">
                <span className="workflow-edge-key is-solid" />
                Solid teal edges are the route you already locked in.
              </span>
              <span className="workflow-legend-item">
                <span className="workflow-edge-key is-soft" />
                Soft blue edges are the next possible extension.
              </span>
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

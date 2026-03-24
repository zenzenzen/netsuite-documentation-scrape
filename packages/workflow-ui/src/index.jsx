import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, Panel, Position, ReactFlow } from '@xyflow/react';
import { animate, stagger } from 'animejs';
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  buildAtomicConfig,
  buildRequestBundle,
  buildShareQuery,
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

function buildFlowGraph(layout, lockedLevels, pendingSelection, favorites, handlers) {
  const { stateMap, previewSet } = buildNodeStateMap(layout, lockedLevels, pendingSelection);
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

function RecordNode({ data }) {
  const { node, state, tone, favorite, onToggle, onPin, onOpenDocs } = data;

  return (
    <div
      className={`workflow-node-shell is-${state}`}
      style={{ '--node-accent': tone.accent, '--node-surface': tone.surface }}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <button
        className="workflow-node-button"
        type="button"
        onClick={() => onToggle(node.recordName)}
        aria-pressed={state === 'queued'}
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
      </button>
      <div className="workflow-node-actions">
        <button type="button" className="workflow-node-action" onClick={() => onOpenDocs(node.docsPath)}>
          Open docs
        </button>
        <button type="button" className="workflow-node-action" onClick={() => onPin(node.recordName)}>
          {favorite ? 'Pinned' : 'Pin'}
        </button>
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
  const [copyState, setCopyState] = useState('');
  const graphRef = useRef(null);
  const currentWorkflow = workflowMap.get(state.baseSlug) || null;
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
    setState({
      baseRecord: nextRecord?.recordName || nextSlug,
      baseSlug: nextSlug,
      lockedLevels: [[nextRecord?.recordName || nextSlug]],
    });
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

  const graph = useMemo(
    () =>
      currentWorkflow
        ? buildFlowGraph(currentWorkflow, state.lockedLevels, pendingSelection, favorites, {
            onToggle: handleToggle,
            onPin: handlePin,
            onOpenDocs: handleOpenDocs,
          })
        : { nodes: [], edges: [], previewTargets: [] },
    [currentWorkflow, favorites, pendingSelection, state.lockedLevels]
  );

  const bundle = useMemo(
    () =>
      currentWorkflow
        ? buildRequestBundle(currentWorkflow, state.baseRecord, state.lockedLevels)
        : null,
    [currentWorkflow, state.baseRecord, state.lockedLevels]
  );

  const atomicConfig = useMemo(
    () =>
      currentWorkflow
        ? buildAtomicConfig(currentWorkflow, state.baseRecord, state.lockedLevels)
        : null,
    [currentWorkflow, state.baseRecord, state.lockedLevels]
  );

  const previewRecords = useMemo(
    () => graph.previewTargets.map((recordName) => findRecordByName(workflowIndex, recordName)).filter(Boolean),
    [graph.previewTargets, workflowIndex]
  );

  const favoritesMeta = useMemo(
    () => favorites.map((recordName) => findRecordByName(workflowIndex, recordName)).filter(Boolean),
    [favorites, workflowIndex]
  );

  const lockedPath = useMemo(
    () =>
      state.lockedLevels.map((level) =>
        level.map((recordName) => findRecordByName(workflowIndex, recordName)?.title || recordName)
      ),
    [state.lockedLevels, workflowIndex]
  );

  return (
    <section className="workflow-studio-route">
      <header className="workflow-hero-card">
        <div className="workflow-hero-copy">
          <p className="workflow-kicker">Workflow Studio</p>
          <h1>{activeRecord?.title || currentWorkflow?.baseRecord || initialWorkflow.baseRecord} transform atlas</h1>
          <p>
            Cached NetSuite object relationships render as a left-to-right transform map. Queue preview
            branches, lock the route forward, and export the exact query string, request bundle, and atomic
            config that describe the chosen path.
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
            <button type="button" onClick={handleCommit} disabled={pendingSelection.length === 0 || !currentWorkflow}>
              Lock selected
            </button>
            <button
              type="button"
              onClick={handleBack}
              disabled={pendingSelection.length === 0 && state.lockedLevels.length === 1}
            >
              Back
            </button>
            <button type="button" onClick={handleReset} disabled={!currentWorkflow}>
              Reset
            </button>
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
                  const record = findRecordByName(workflowIndex, recordName);
                  return <span className="workflow-mini-pill" key={recordName}>{record?.title || recordName}</span>;
                })
              ) : (
                <span className="muted">Click any faded preview node to queue it.</span>
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
            <pre>{bundle ? `?${bundle.shareQuery}` : 'Loading...'}</pre>
            <button
              type="button"
              onClick={() => bundle && handleCopy(`?${bundle.shareQuery}`, 'Share query')}
              disabled={!bundle}
            >
              Copy query
            </button>
          </section>

          <section className="workflow-rail-card">
            <h2>Request bundle</h2>
            <pre>{bundle ? JSON.stringify(bundle, null, 2) : 'Loading...'}</pre>
            <button
              type="button"
              onClick={() => bundle && handleCopy(JSON.stringify(bundle, null, 2), 'Request bundle')}
              disabled={!bundle}
            >
              Copy bundle
            </button>
          </section>

          <section className="workflow-rail-card">
            <h2>Atomic config</h2>
            <pre>{atomicConfig ? JSON.stringify(atomicConfig, null, 2) : 'Loading...'}</pre>
            <button
              type="button"
              onClick={() => atomicConfig && handleCopy(JSON.stringify(atomicConfig, null, 2), 'Atomic config')}
              disabled={!atomicConfig}
            >
              Copy config
            </button>
            {copyState ? <p className="workflow-copy-note">{copyState}</p> : null}
          </section>
        </aside>
      </div>
    </section>
  );
}

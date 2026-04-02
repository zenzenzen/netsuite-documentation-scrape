# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all workspace dependencies
npm install

# Build all workspaces
npm run build

# Build the Astro docs site only (primary deployment artifact)
npm run docs:build

# Build the Next.js app shell only
npm run app:build

# Full data pipeline: scrape NetSuite + build all generated outputs
npm run netsuite:docs

# Scrape NetSuite REST API docs into data/netsuite/raw/
npm run netsuite:scrape

# Process raw data into generated JSON indices, record HTML, and workflow graphs
npm run netsuite:build

# Serve the generated static HTML locally
npm run netsuite:serve

# Playwright helpers (browser automation)
npm run playwright:install    # Download Chromium
npm run playwright:test       # Run e2e tests
npm run playwright:open [URL] # Open browser with inspector
```

There is no dedicated lint or typecheck command in this repo.

## Architecture

This is an npm workspaces monorepo (`apps/*`, `packages/*`) that scrapes NetSuite REST API documentation and builds a browsable static site with interactive workflow visualization.

### Data pipeline

```
1. scripts/netsuite/scrape-rest-browser.mjs
   Playwright headless browser automation → data/netsuite/raw/records/*.json

2. scripts/netsuite/build-docs-site.mjs
   Reads raw records → uses @netsuite/workflow-core to categorize and build
   layered workflow graphs → emits:
     packages/netsuite-data/generated/  (records-index.json, workflow-index.json, workflows/*.json)
     public/records/*.html              (per-record static pages)
     public.html / transforms.html      (root-level HTML)
     workflow-map.json

3. apps/docs build (Astro)
   sync:workflow-data copies generated JSON + HTML into Astro public/,
   then `astro build` → apps/docs/dist/  (deployed to Vercel)
```

### Package dependency order

```
@netsuite/design-tokens         ← no internal deps; provides categoryPalette + grapefruitTheme
  ↑
@netsuite/workflow-core         ← categorization rules, graph layout (buildLayeredWorkflow),
  |                               request builders (buildRecordRequest, buildTransformBundle)
  ↑
@netsuite/netsuite-data         ← path resolution + loaders for generated JSON artifacts
  ↑
@netsuite/workflow-ui           ← <WorkflowStudio /> React component using @xyflow/react
  ↑
apps/docs (Astro)               ← primary site; imports all four packages; client:only React island
apps/app  (Next.js)             ← thin shell; future evolution; imports netsuite-data + design-tokens
```

The generated artifacts in `packages/netsuite-data/generated/` are committed to the repo, so `apps/docs` can build without running the scrape.

### Key files

| Purpose | Path |
|---------|------|
| Workspace scripts | `package.json` |
| Scrape automation | `scripts/netsuite/scrape-rest-browser.mjs` |
| Build pipeline | `scripts/netsuite/build-docs-site.mjs` |
| Shared script utilities | `scripts/netsuite/shared.mjs` |
| Astro site entry | `apps/docs/src/pages/index.astro` |
| Workflow page | `apps/docs/src/pages/workflow/index.astro` |
| WorkflowStudio React component | `packages/workflow-ui/src/index.jsx` |
| Graph/request logic | `packages/workflow-core/src/index.js` |
| Generated data loader | `packages/netsuite-data/src/index.js` |
| Color palette | `packages/design-tokens/src/index.js` |
| Astro config | `apps/docs/astro.config.mjs` |
| Vercel config | `vercel.json` |
| Env template | `.env.example` |

### WorkflowStudio component

`<WorkflowStudio />` (in `@netsuite/workflow-ui`) is the primary interactive UI. It renders as a `client:only` React island in the Astro site. Its props are `workflowIndex`, `initialWorkflow`, and `initialBaseSlug`. Internally it uses React Flow (`@xyflow/react`) for the DAG canvas and `animejs` for transitions. Interaction state lives in component state; sharable URLs are built via `buildShareQuery` / `parseShareQuery` from `workflow-core`.

### Environment variables

Needed only for `netsuite:scrape`. Copy `.env.example` to `.env`:

```
NETSUITE_DOCS_URL=      # NetSuite REST API Browser HTML URL
NETSUITE_EMAIL=
NETSUITE_PASSWORD=
NETSUITE_ACCOUNT_ID=
NETSUITE_ALLOW_MANUAL_MFA=false
HEADLESS=true
NETSUITE_SCRAPE_ALL=true
```

## Design principles (from AGENTS.md + docs/agent-native-architecture.md)

- **User-agent parity**: every action the UI supports should have an equivalent agent-callable path.
- **Atomic primitives over workflow-shaped tools**: keep granular tools available even when adding shortcuts.
- **File-backed state**: prefer inspectable, portable JSON/HTML artifacts over in-memory-only representations.
- **Composability**: new capabilities should be achievable via prompts before new code.

## Delivery workflow

- Land work on a branch, open a PR, merge to `main` — avoid leaving large changes unreviewed on `main`.
- Use the `codex/` branch prefix unless asked otherwise.
- Include a short `Rationale:` section in commit bodies for milestone commits.
- When opening a PR, document user-facing changes, key technical decisions, verification steps, and any intentional follow-up work.

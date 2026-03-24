# netsuite-documentation-scrape

Workspace for scraping NetSuite REST API documentation and building local browsable docs pages.

## Workspace layout

This repo now includes npm workspaces so the current static docs flow can coexist with future app shells:

- [`/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/apps/docs`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/apps/docs) for the Astro docs shell
- [`/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/apps/app`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/apps/app) for the future Next.js App Router shell
- [`/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/workflow-core`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/workflow-core) for workflow graph/category primitives
- [`/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/netsuite-data`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/netsuite-data) for shared generated JSON artifacts
- [`/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/design-tokens`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/packages/design-tokens) for cross-app theme tokens

## Architecture guidance

Agentic tooling and build-tooling work in this repo should follow the stored reference at [`docs/agent-native-architecture.md`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/docs/agent-native-architecture.md). Repo-local instructions also mirror that guidance in [`AGENTS.md`](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/AGENTS.md).

## Included

- Local Playwright setup for browser automation
- NetSuite scrape and local docs build scripts
- Generated data and local HTML output
- `output/playwright/` for screenshots, traces, and other browser artifacts

## Common commands

```bash
npm install
npm run playwright:install
npm run playwright:open https://example.com
npm run playwright:codegen https://example.com
npm run docs:build
npm run app:build
```

## NetSuite docs workflow

1. Copy `.env.example` to `.env` and add your NetSuite credentials if the docs site prompts for login.
2. Scrape the NetSuite REST API browser into local JSON files:

```bash
npm run netsuite:scrape
```

3. Build the colorful local docs pages:

```bash
npm run netsuite:build
```

4. Open the generated files directly or serve them locally:

```bash
open public.html
npm run netsuite:serve
```

## Workspace folders

- `scripts/` for scrape and utility scripts
- `data/` for raw scraped record metadata
- `public/` and `public.html` for generated documentation pages
- `apps/` for future runtime shells
- `packages/` for shared workflow/data foundations
- `notes/` and `projects/` for supporting material

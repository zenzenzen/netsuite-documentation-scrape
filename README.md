# netsuite-documentation-scrape

Workspace for scraping NetSuite REST API documentation and building local browsable docs pages.

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
- `notes/` and `projects/` for supporting material

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

const projectDir = fileURLToPath(new URL('.', import.meta.url));
const worktreeRoot = path.resolve(projectDir, '..', '..');
const repoRoot = path.resolve(worktreeRoot, '..', '..', '..');

function normalizeBasePath(input = '/') {
  const value = String(input || '').trim();

  if (!value || value === '/') {
    return '/';
  }

  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig({
  integrations: [react()],
  output: 'static',
  base: normalizeBasePath(process.env.DOCS_BASE_PATH || '/'),
  vite: {
    server: {
      fs: {
        allow: [worktreeRoot, repoRoot],
      },
    },
  },
});

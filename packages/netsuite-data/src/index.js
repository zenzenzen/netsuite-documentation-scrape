import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GENERATED_ROOT = path.resolve(__dirname, '..', 'generated');
export const GENERATED_WORKFLOWS_ROOT = path.join(GENERATED_ROOT, 'workflows');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function getRecordsIndex() {
  return readJson(path.join(GENERATED_ROOT, 'records-index.json'), []);
}

export function getWorkflowIndex() {
  return readJson(path.join(GENERATED_ROOT, 'workflow-index.json'), []);
}

export function getWorkflowLayout(slug) {
  return readJson(path.join(GENERATED_WORKFLOWS_ROOT, `${slug}.json`), null);
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveGeneratedRoot() {
  const candidates = [
    path.resolve(__dirname, '..', 'generated'),
    path.resolve(process.cwd(), 'packages/netsuite-data/generated'),
    path.resolve(process.cwd(), '..', 'packages/netsuite-data/generated'),
    path.resolve(process.cwd(), '..', '..', 'packages/netsuite-data/generated'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

export const GENERATED_ROOT = resolveGeneratedRoot();
export const GENERATED_RECORDS_ROOT = path.join(GENERATED_ROOT, 'records');
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

export function getRecordDetail(slug) {
  return readJson(path.join(GENERATED_RECORDS_ROOT, `${slug}.json`), null);
}

export function getMigratedRecordSlugs() {
  return getRecordsIndex()
    .filter((record) => String(record.docsPath || '').startsWith('/records/'))
    .map((record) => record.slug);
}

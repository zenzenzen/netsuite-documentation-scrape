import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveRepoRoot() {
  const candidates = [
    path.resolve(process.cwd(), '..', '..'),
    path.resolve(process.cwd(), '..'),
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..', '..'),
  ];

  return (
    candidates.find((candidate) => fs.existsSync(path.join(candidate, 'workflow-map.json'))) || candidates[0]
  );
}

const repoRoot = resolveRepoRoot();
const workflowConfigPath = path.join(repoRoot, 'workflow-map.json');
const workflowLayoutsRoot = path.join(repoRoot, 'packages', 'netsuite-data', 'generated', 'workflows');

export function readWorkflowConfig() {
  return JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
}

export function readWorkflowLayout(slug) {
  return JSON.parse(fs.readFileSync(path.join(workflowLayoutsRoot, `${slug}.json`), 'utf8'));
}

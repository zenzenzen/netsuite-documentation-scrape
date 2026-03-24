import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_WORKFLOWS_ROOT, getWorkflowIndex } from '@netsuite/netsuite-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicWorkflowRoot = path.resolve(__dirname, '..', 'public', 'workflow-data');

fs.mkdirSync(publicWorkflowRoot, { recursive: true });

for (const workflow of getWorkflowIndex()) {
  const sourcePath = path.join(GENERATED_WORKFLOWS_ROOT, `${workflow.slug}.json`);
  const targetPath = path.join(publicWorkflowRoot, `${workflow.slug}.json`);

  if (!fs.existsSync(sourcePath)) {
    continue;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

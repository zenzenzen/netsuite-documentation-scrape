import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_WORKFLOWS_ROOT, getWorkflowIndex } from '@netsuite/netsuite-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicWorkflowRoot = path.resolve(__dirname, '..', 'public', 'workflow-data');
const rootRecordsDirectory = path.resolve(__dirname, '..', '..', '..', 'public', 'records');
const docsRecordsDirectory = path.resolve(__dirname, '..', 'public', 'records');
const sharedRootAssets = ['app.css', 'app.js', 'favicon.svg'];

fs.mkdirSync(publicWorkflowRoot, { recursive: true });
fs.mkdirSync(docsRecordsDirectory, { recursive: true });

for (const workflow of getWorkflowIndex()) {
  const sourcePath = path.join(GENERATED_WORKFLOWS_ROOT, `${workflow.slug}.json`);
  const targetPath = path.join(publicWorkflowRoot, `${workflow.slug}.json`);

  if (!fs.existsSync(sourcePath)) {
    continue;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

if (fs.existsSync(rootRecordsDirectory)) {
  fs.cpSync(rootRecordsDirectory, docsRecordsDirectory, { recursive: true });
}

for (const assetName of sharedRootAssets) {
  const sourcePath = path.resolve(__dirname, '..', '..', '..', assetName);
  const targetPath = path.resolve(__dirname, '..', 'public', assetName);

  if (!fs.existsSync(sourcePath)) {
    continue;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

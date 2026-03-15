import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const DATA_ROOT = path.join(PROJECT_ROOT, 'data', 'netsuite');
export const RAW_ROOT = path.join(DATA_ROOT, 'raw');
export const RAW_RECORDS_DIR = path.join(RAW_ROOT, 'records');
export const AUTH_DIR = path.join(DATA_ROOT, 'auth');
export const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'storage-state.json');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const PUBLIC_RECORDS_DIR = path.join(PUBLIC_DIR, 'records');
export const PUBLIC_HOME_FILE = path.join(PROJECT_ROOT, 'public.html');
export const PUBLIC_TRANSFORMS_FILE = path.join(PROJECT_ROOT, 'transforms.html');

export const DEFAULT_DOCS_URL =
  'https://system.netsuite.com/help/helpcenter/en_US/APIs/REST_API_Browser/record/v1/2025.2/index.html';

export const RECORD_ALIASES = {
  creditemo: 'creditMemo',
  creditmemo: 'creditMemo',
  customerpayment: 'customerPayment',
  itemfulfillment: 'itemFulfillment',
  paymentitem: 'paymentItem',
  salesorder: 'salesOrder',
  vendorreturnauthorization: 'vendorReturnAuthorization',
};

export const FOCUS_RECORD_INPUTS = [
  'customer',
  'creditemo',
  'invoice',
  'itemfulfillment',
  'salesorder',
  'subsidiary',
  'paymentitem',
  'partner',
];

export const FOCUS_RECORDS = Array.from(
  new Set(FOCUS_RECORD_INPUTS.map((name) => resolveRecordName(name)))
);

export function resolveRecordName(name) {
  if (!name) {
    return '';
  }

  const trimmed = String(name).trim();
  const exactAlias = RECORD_ALIASES[trimmed];

  if (exactAlias) {
    return exactAlias;
  }

  if (!trimmed.includes('-') && !trimmed.includes('_') && /[A-Z]/.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  if (RECORD_ALIASES[lower]) {
    return RECORD_ALIASES[lower];
  }

  return trimmed.replace(/[-_\s]+([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value);
}

export function loadEnvFile(filePath = path.join(PROJECT_ROOT, '.env')) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value.replace(/\\n/g, '\n');
  }

  return env;
}

export function getRuntimeEnv() {
  const fileEnv = loadEnvFile();
  return { ...fileEnv, ...process.env };
}

export function compact(items) {
  return items.filter(Boolean);
}

export function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

export function toTitleCase(value) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function slugify(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function methodTone(method) {
  switch (method) {
    case 'GET':
      return 'tone-get';
    case 'POST':
      return 'tone-post';
    case 'PATCH':
      return 'tone-patch';
    case 'PUT':
      return 'tone-put';
    case 'DELETE':
      return 'tone-delete';
    default:
      return 'tone-neutral';
  }
}

export function relativeLinkFromRoot(recordName) {
  return `./public/records/${slugify(recordName)}.html`;
}

export function relativeLinkFromRecord(recordName) {
  return `./${slugify(recordName)}.html`;
}

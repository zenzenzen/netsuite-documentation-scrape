import { categoryPalette } from '@netsuite/design-tokens';

const RECORD_API_ROOT = '{{NETSUITE_BASE_URL}}/services/rest/record/v1';

const CATEGORY_RULES = [
  {
    category: 'transaction',
    patterns: [
      'salesorder',
      'invoice',
      'estimate',
      'creditmemo',
      'returnauthorization',
      'cashsale',
      'cashrefund',
      'purchaseorder',
      'vendorbill',
      'workorder',
      'transferorder',
      'journal',
      'deposit',
      'payment',
    ],
  },
  {
    category: 'entity',
    patterns: [
      'customer',
      'vendor',
      'employee',
      'partner',
      'contact',
      'job',
      'lead',
      'prospect',
    ],
  },
  {
    category: 'inventory',
    patterns: [
      'item',
      'fulfillment',
      'inventory',
      'assembly',
      'bin',
      'shipment',
      'receipt',
      'serial',
    ],
  },
  {
    category: 'catalog',
    patterns: ['promotion', 'coupon', 'price', 'catalog', 'website', 'site'],
  },
  {
    category: 'organization',
    patterns: ['subsidiary', 'department', 'classification', 'location', 'accountingperiod'],
  },
  {
    category: 'financial',
    patterns: ['account', 'currency', 'tax', 'ledger', 'expense', 'revenue', 'billing'],
  },
  {
    category: 'reference',
    patterns: ['term', 'status', 'type', 'method', 'schedule', 'category', 'nexus'],
  },
];

export function normalizeRecordName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function resolveCategory(recordName) {
  const normalized = normalizeRecordName(recordName);

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => normalized.includes(pattern))) {
      return rule.category;
    }
  }

  return 'other';
}

export function enrichRecordCategory(record) {
  const category = resolveCategory(record.recordName || record.slug || record.title);
  return {
    ...record,
    category,
    categoryLabel: categoryPalette[category]?.label || categoryPalette.other.label,
  };
}

export function buildLayeredWorkflow(records, transforms, baseRecord) {
  const recordMap = new Map(records.map((record) => [record.recordName, enrichRecordCategory(record)]));
  const outgoing = new Map();

  for (const transform of transforms) {
    if (!outgoing.has(transform.source)) {
      outgoing.set(transform.source, []);
    }
    outgoing.get(transform.source).push(transform);
  }

  const layers = [];
  const seen = new Set();
  let frontier = [baseRecord];
  let depth = 0;

  while (frontier.length) {
    const nodes = frontier
      .map((recordName) => recordMap.get(recordName))
      .filter(Boolean)
      .filter((record) => !seen.has(record.recordName));

    if (!nodes.length) {
      break;
    }

    for (const node of nodes) {
      seen.add(node.recordName);
    }

    layers.push({
      depth,
      nodes: nodes.map((node, index) => ({
        ...node,
        position: { x: depth, y: index },
      })),
    });

    frontier = Array.from(
      new Set(
        nodes.flatMap((node) => (outgoing.get(node.recordName) || []).map((edge) => edge.target))
      )
    ).filter((target) => !seen.has(target));
    depth += 1;
  }

  return {
    baseRecord,
    layers,
    edges: transforms.filter((transform) => recordMap.has(transform.source) && recordMap.has(transform.target)),
  };
}

export function categoryColor(category) {
  return categoryPalette[category] || categoryPalette.other;
}

export function findRecordBySlug(records, slug) {
  return records.find((record) => record.slug === slug) || null;
}

export function findRecordByName(records, recordName) {
  return (
    records.find(
      (record) =>
        record.recordName === recordName ||
        record.slug === recordName ||
        normalizeRecordName(record.recordName) === normalizeRecordName(recordName)
    ) || null
  );
}

export function parseShareQuery(search, workflowIndex) {
  const params = new URLSearchParams(search || '');
  const baseInput = params.get('base');
  const levelsInput = params.get('levels');
  const baseRecord = findRecordByName(workflowIndex, baseInput);

  if (!baseRecord) {
    return null;
  }

  const lockedLevels = [[baseRecord.recordName]];
  if (levelsInput) {
    for (const level of levelsInput.split(';')) {
      const records = level
        .split(',')
        .map((item) => findRecordByName(workflowIndex, item)?.recordName)
        .filter(Boolean);

      if (records.length) {
        lockedLevels.push(Array.from(new Set(records)));
      }
    }
  }

  return {
    baseRecord: baseRecord.recordName,
    baseSlug: baseRecord.slug,
    lockedLevels,
  };
}

export function buildShareQuery(baseReference, lockedLevels) {
  const params = new URLSearchParams();
  params.set('base', baseReference);

  if (lockedLevels.length > 1) {
    params.set(
      'levels',
      lockedLevels
        .slice(1)
        .map((level) => level.join(','))
        .join(';')
    );
  }

  return params.toString();
}

export function findTransform(edges, source, target) {
  return edges.find((edge) => edge.source === source && edge.target === target) || null;
}

export function buildRecordRequest(recordName) {
  return {
    name: `GET ${recordName}`,
    method: 'GET',
    url: `${RECORD_API_ROOT}/${recordName}/{{${recordName}Id}}`,
  };
}

export function buildTransformRequest(transform) {
  return {
    name: `POST ${transform.source} -> ${transform.target}`,
    method: 'POST',
    url: `${RECORD_API_ROOT}${transform.path.replace('{id}', `{{${transform.source}Id}}`)}`,
  };
}

export function buildRequestBundle(workflowLayout, baseRecord, lockedLevels) {
  const selectedTransforms = [];

  for (let index = 0; index < lockedLevels.length - 1; index += 1) {
    for (const source of lockedLevels[index]) {
      for (const target of lockedLevels[index + 1]) {
        const transform = findTransform(workflowLayout.edges, source, target);
        if (transform) {
          selectedTransforms.push(transform);
        }
      }
    }
  }

  const seenRequests = new Set();
  const requests = [];
  for (const recordName of Array.from(new Set(lockedLevels.flat()))) {
    const request = buildRecordRequest(recordName);
    const key = `${request.method}:${request.url}`;
    if (!seenRequests.has(key)) {
      seenRequests.add(key);
      requests.push(request);
    }
  }

  for (const transform of selectedTransforms) {
    const request = buildTransformRequest(transform);
    const key = `${request.method}:${request.url}`;
    if (!seenRequests.has(key)) {
      seenRequests.add(key);
      requests.push(request);
    }
  }

  return {
    shareQuery: buildShareQuery(baseRecord, lockedLevels),
    selectedTransforms,
    requests,
  };
}

export function buildAtomicConfig(workflowLayout, baseRecord, lockedLevels) {
  const bundle = buildRequestBundle(workflowLayout, baseRecord, lockedLevels);

  return {
    version: 1,
    baseRecord,
    vector: lockedLevels.map((records, depth) => ({ depth, records })),
    selectedTransforms: bundle.selectedTransforms.map((transform) => ({
      source: transform.source,
      target: transform.target,
      method: transform.method,
      path: transform.path,
    })),
  };
}

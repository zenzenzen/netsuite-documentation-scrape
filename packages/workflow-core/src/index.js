import { categoryPalette } from '@netsuite/design-tokens';

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

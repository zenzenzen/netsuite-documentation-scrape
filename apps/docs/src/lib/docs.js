export function toSiteHref(input) {
  const value = String(input || '');

  if (!value) {
    return '#';
  }

  if (value.startsWith('/')) {
    return value;
  }

  return `/${value.replace(/^\.\//, '')}`;
}

export function buildDocsPathMap(records) {
  return new Map(records.map((record) => [record.recordName, toSiteHref(record.docsPath)]));
}

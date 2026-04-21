function getSiteBasePath() {
  return normalizeBasePath(import.meta.env?.BASE_URL || '/');
}

export function normalizeBasePath(input = '/') {
  const value = String(input || '').trim();

  if (!value || value === '/') {
    return '/';
  }

  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export function toSiteHref(input, basePath = getSiteBasePath()) {
  const value = String(input || '').trim();

  if (!value) {
    return null;
  }

  if (/^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith('#')) {
    return value;
  }

  const normalizedBasePath = normalizeBasePath(basePath);
  const normalizedPath = `/${value.replace(/^\.\//, '').replace(/^\/+/, '')}`;

  if (
    normalizedBasePath !== '/' &&
    (normalizedPath === normalizedBasePath.slice(0, -1) || normalizedPath.startsWith(normalizedBasePath))
  ) {
    return normalizedPath;
  }

  return normalizedBasePath === '/'
    ? normalizedPath
    : `${normalizedBasePath.slice(0, -1)}${normalizedPath}`;
}

export function buildDocsPathMap(records, basePath = getSiteBasePath()) {
  return new Map(
    records
      .map((record) => [record.recordName, toSiteHref(record.docsPath, basePath)])
      .filter(([, href]) => Boolean(href))
  );
}

export function buildMissingRecordReason(recordName) {
  return `${recordName} is referenced in the scrape, but it is not part of the indexed docs dataset yet.`;
}

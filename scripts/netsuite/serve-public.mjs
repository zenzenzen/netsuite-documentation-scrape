import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './shared.mjs';

const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const requestPath = request.url === '/' ? '/public.html' : request.url;
  const resolvedPath = path.resolve(PROJECT_ROOT, `.${requestPath}`);

  if (!resolvedPath.startsWith(PROJECT_ROOT)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const ext = path.extname(resolvedPath);
  response.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8',
  });
  response.end(fs.readFileSync(resolvedPath));
});

server.listen(port, () => {
  console.log(`Serving generated docs at http://localhost:${port}/public.html`);
});

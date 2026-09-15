import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCertificates, lanAddresses } from './certificates.js';

const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));
const threeRoot = fileURLToPath(new URL('./node_modules/three/build/', import.meta.url));
const vendors = new Set(['three.module.js', 'three.core.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

export async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-cache');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    res.writeHead(405).end('Method not allowed');
    return;
  }
  try {
    const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/api/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, phase: 1, protocol: 'https' }));
      return;
    }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let file;
    if (pathname.startsWith('/vendor/')) {
      const name = pathname.slice('/vendor/'.length);
      if (!vendors.has(name)) { res.writeHead(404).end('Not found'); return; }
      file = resolve(threeRoot, name);
    } else {
      file = resolve(clientRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!file.startsWith(resolve(clientRoot) + sep) || !mime[extname(file)]) {
        res.writeHead(403).end('Forbidden'); return;
      }
    }
    const body = await readFile(file);
    res.setHeader('Content-Type', mime[extname(file)]);
    res.setHeader('Content-Length', body.length);
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const status = error instanceof URIError ? 400 : ['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code) ? 404 : 500;
    if (status === 500) console.error(error);
    res.writeHead(status).end(status === 500 ? 'Server error' : 'Not found or invalid path');
  }
}

export async function createServer(options = {}) {
  return https.createServer({ ...await ensureCertificates(options), minVersion: 'TLSv1.2' }, handleRequest);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const server = await createServer();
  server.on('error', error => { console.error(`Unable to start HTTPS server: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nRacquetball VR · Phase 1\n  https://localhost:${port}`);
    for (const address of lanAddresses()) console.log(`  https://${address}:${port}`);
    console.log('\nOpen a LAN address in Quest Browser on the same Wi-Fi.\nSelf-signed TLS requires browser acceptance/trust. See README.md.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}

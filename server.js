'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, CATEGORIES, CONDITIONS } = require('./src/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 100 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/api/meta' && req.method === 'GET') {
        return sendJson(res, 200, { categories: CATEGORIES, conditions: CONDITIONS });
      }
      if (pathname === '/api/booths' && req.method === 'GET') {
        return sendJson(res, 200, store.listBooths());
      }
      if (pathname === '/api/products' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        return sendJson(res, 200, store.listProducts(q));
      }
      if (pathname === '/api/products' && req.method === 'POST') {
        const product = store.addProduct(await readJson(req));
        return sendJson(res, 201, product);
      }
      const match = pathname.match(/^\/api\/products\/([\w-]+)$/);
      if (match && req.method === 'GET') {
        const product = store.getProduct(match[1]);
        return product ? sendJson(res, 200, product) : sendJson(res, 404, { error: 'Item not found.' });
      }
      if (pathname === '/api/orders' && req.method === 'POST') {
        const order = store.createOrder(await readJson(req));
        return sendJson(res, 201, order);
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      res.writeHead(405).end();
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, {
        error: status === 500 ? 'Something went wrong.' : err.message,
        ...(err.soldIds ? { soldIds: err.soldIds } : {}),
      });
    }
  });
}

if (require.main === module) {
  const store = new Store({
    dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'),
    seedFile: path.join(__dirname, 'data', 'seed.json'),
  });
  const port = Number(process.env.PORT) || 3000;
  createServer(store).listen(port, () => {
    console.log(`Thrift store running at http://localhost:${port}`);
  });
}

module.exports = { createServer };

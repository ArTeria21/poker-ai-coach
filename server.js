/**
 * Poker Mentor server: serves the built SPA and a tiny JSON storage API so
 * lesson progress and hand history sync across devices. Zero dependencies.
 *
 *   GET  /api/health            → { ok: true }
 *   GET  /api/state/:key        → stored JSON or null
 *   PUT  /api/state/:key        → save JSON body
 *   GET  /api/hands             → all stored hands (array)
 *   GET  /api/hands/ids         → stored hand ids (array)
 *   PUT  /api/hands/:handId     → save one hand
 *
 * Data lives in DATA_DIR (default ./data; /data in the container volume).
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 80);
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ---------------------------------------------------------------- storage

/** All hands, keyed by handId; loaded once, flushed atomically on change. */
const hands = new Map();
const HANDS_FILE = path.join(DATA_DIR, 'hands.json');
let flushTimer = null;

async function loadData() {
  await fs.mkdir(path.join(DATA_DIR, 'state'), { recursive: true });
  try {
    const raw = JSON.parse(await fs.readFile(HANDS_FILE, 'utf8'));
    for (const [id, hand] of Object.entries(raw)) hands.set(id, hand);
    console.log(`loaded ${hands.size} hands`);
  } catch {
    /* first boot */
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushHands();
  }, 500);
}

async function flushHands() {
  const tmp = `${HANDS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(hands)));
  await fs.rename(tmp, HANDS_FILE);
}

function stateFile(key) {
  if (!/^[a-z0-9-]{1,64}$/.test(key)) return null;
  return path.join(DATA_DIR, 'state', `${key}.json`);
}

// ------------------------------------------------------------------ http

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') return json(res, 200, { ok: true });

  const stateMatch = pathname.match(/^\/api\/state\/([a-z0-9-]+)$/);
  if (stateMatch) {
    const file = stateFile(stateMatch[1]);
    if (!file) return json(res, 400, { error: 'bad key' });
    if (req.method === 'GET') {
      try {
        return json(res, 200, JSON.parse(await fs.readFile(file, 'utf8')));
      } catch {
        return json(res, 200, null);
      }
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(body));
      await fs.rename(tmp, file);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/hands' && req.method === 'GET') {
    return json(res, 200, [...hands.values()]);
  }
  if (pathname === '/api/hands/ids' && req.method === 'GET') {
    return json(res, 200, [...hands.keys()]);
  }
  const handMatch = pathname.match(/^\/api\/hands\/([A-Za-z0-9_.-]+)$/);
  if (handMatch && req.method === 'PUT') {
    const hand = JSON.parse(await readBody(req));
    if (!hand || hand.handId !== handMatch[1]) return json(res, 400, { error: 'handId mismatch' });
    hands.set(hand.handId, hand);
    scheduleFlush();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

async function handleStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(DIST, pathname));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    await fs.access(filePath);
  } catch {
    filePath = path.join(DIST, 'index.html'); // SPA fallback
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const handler = pathname.startsWith('/api/') ? handleApi : handleStatic;
  handler(req, res, pathname).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  });
});

await loadData();
server.listen(PORT, () => console.log(`poker-mentor listening on :${PORT}, data in ${DATA_DIR}`));

process.on('SIGTERM', () => {
  void flushHands().finally(() => process.exit(0));
});

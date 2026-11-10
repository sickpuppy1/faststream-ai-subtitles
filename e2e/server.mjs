#!/usr/bin/env node
// Dependency-free static server for the e2e/ tree.
// Usage: node e2e/server.mjs [--port 8765]
//   Serves the same tree on PORT and PORT+1 (second origin for cross-origin iframes).
// Env: LATENCY_MS (default 60) delay before every response.
//      THROTTLE_KBPS (default 0 = off) body rate limit, to mimic a slow CDN.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const pi = argv.indexOf('--port');
const PORT = pi >= 0 ? Number(argv[pi + 1]) : 8765;
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 60);
const THROTTLE_KBPS = Number(process.env.THROTTLE_KBPS ?? 0);

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mpd': 'application/dash+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.aiff': 'audio/aiff',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, *',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '600',
};

// Resolve a request path to a file inside ROOT, or null.
function resolveFile(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (p === '/') return path.join(ROOT, 'site', 'index.html');
  const full = path.normalize(path.join(ROOT, p));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    const idx = path.join(full, 'index.html');
    return fs.existsSync(idx) ? idx : null;
  }
  return full;
}

// Parse "bytes=a-b", "bytes=a-", "bytes=-n". Returns {start,end} | 'invalid' | null.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return {start, end};
}

const sleepMs = (ms) => (ms > 0 ? sleep(ms) : Promise.resolve());

async function sendBody(stream, res) {
  if (THROTTLE_KBPS <= 0) {
    stream.pipe(res);
    return;
  }
  // Throttle: after each chunk, wait as long as that chunk would take at THROTTLE_KBPS.
  for await (const chunk of stream) {
    if (res.destroyed) break;
    if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    await sleepMs((chunk.length / (THROTTLE_KBPS * 1024)) * 1000);
  }
  res.end();
}

function makeHandler(port) {
  return async (req, res) => {
    const t0 = Date.now();
    const logLine = () => {
      const status = res.statusCode;
      const range = req.headers.range ? ` range=${req.headers.range}` : '';
      const ms = Date.now() - t0;
      console.log(`${new Date().toISOString()} :${port} ${req.method} ${req.url}${range} ${status} ${ms}ms`);
    };
    res.on('finish', logLine);
    res.on('close', () => {
      if (!res.writableFinished) logLine();
    });

    await sleepMs(LATENCY_MS);
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {Allow: 'GET, HEAD, OPTIONS'});
      res.end();
      return;
    }

    const file = resolveFile(req.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(file);
    const size = stat.size;
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${size}`);
      res.writeHead(416);
      res.end();
      return;
    }

    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': len,
      });
      if (req.method === 'HEAD') return res.end();
      return sendBody(fs.createReadStream(file, {start: range.start, end: range.end}), res);
    }

    res.writeHead(200, {'Content-Length': size});
    if (req.method === 'HEAD') return res.end();
    return sendBody(fs.createReadStream(file), res);
  };
}

for (const port of [PORT, PORT + 1]) {
  http.createServer(makeHandler(port)).listen(port, () => {
    console.log(`e2e server: http://localhost:${port}/site/index.html  (root ${ROOT})`);
  });
}
console.log(`latency=${LATENCY_MS}ms throttle=${THROTTLE_KBPS ? THROTTLE_KBPS + 'KB/s' : 'off'}`);

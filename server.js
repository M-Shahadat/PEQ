#!/usr/bin/env node
/**
 * Squiglink Local Music Server
 * Run: node server.js
 * Then open: http://localhost:8765
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MUSIC_DIR = '/Users/shahadathemal/musica';
const PORT      = 8765;
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.alac', '.aiff', '.wma']);
const MIME = {
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.alac': 'audio/mp4',
  '.aiff': 'audio/aiff',
  '.wma':  'audio/x-ms-wma',
};
// ─────────────────────────────────────────────────────────────────────────────

function scanDir(dir, base) {
  base = base || '';
  let results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return results; }
  for (const entry of entries) {
    const rel  = path.join(base, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanDir(full, rel));
    } else if (AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(rel);
    }
  }
  return results;
}

// Cache the file list so repeated fetches are fast
let fileListCache = null;
let cacheTime = 0;
function getFileList() {
  const now = Date.now();
  if (!fileListCache || now - cacheTime > 30000) {
    fileListCache = scanDir(MUSIC_DIR);
    cacheTime = now;
  }
  return fileListCache;
}

const PLAYER_PATH = path.join(__dirname, 'player.html');

http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS for localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /music  →  JSON list of relative paths
  if (pathname === '/music') {
    const list = getFileList();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(list));
    return;
  }

  // ── GET /file/<relpath>  →  stream the audio file (supports range requests)
  if (pathname.startsWith('/file/')) {
    const rel  = decodeURIComponent(pathname.slice(6));
    const full = path.resolve(path.join(MUSIC_DIR, rel));

    // Security: must stay inside MUSIC_DIR
    if (!full.startsWith(path.resolve(MUSIC_DIR))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    let stat;
    try { stat = fs.statSync(full); }
    catch (e) { res.writeHead(404); res.end('Not found'); return; }

    const ext  = path.extname(full).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const total = stat.size;

    // Handle Range requests (needed for seek to work)
    const rangeHeader = req.headers['range'];
    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mime,
      });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges':  'bytes',
        'Content-Type':   mime,
      });
      fs.createReadStream(full).pipe(res);
    }
    return;
  }

  // ── GET /  →  serve player.html
  if (pathname === '/' || pathname === '/player.html') {
    try {
      const html = fs.readFileSync(PLAYER_PATH);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('player.html not found next to server.js');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ♫  Squiglink Player running at  http://localhost:' + PORT);
  console.log('  ♫  Scanning music from:         ' + MUSIC_DIR);
  console.log('  ♫  Press Ctrl+C to stop.');
  console.log('');
});

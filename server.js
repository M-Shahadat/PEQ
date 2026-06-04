// #!/usr/bin/env node
// /**
//  * Squiglink Local Music Server
//  * Run: node server.js
//  * Then open: http://localhost:8765
//  *
//  * Music folder is configured via the web UI — stored in config.json next to server.js.
//  * No hardcoded paths.
//  */

// const http = require('http');
// const fs   = require('fs');
// const path = require('path');
// const url  = require('url');

// // ─── CONSTANTS ────────────────────────────────────────────────────────────────
// const PORT       = 8765;
// const CONFIG_PATH = path.join(__dirname, 'config.json');
// const PLAYER_PATH = path.join(__dirname, 'player.html');
// const AUDIO_EXTS  = new Set(['.mp3','.flac','.m4a','.wav','.aac','.ogg','.opus','.alac','.aiff','.wma']);
// const MIME = {
//   '.mp3':  'audio/mpeg',
//   '.flac': 'audio/flac',
//   '.m4a':  'audio/mp4',
//   '.wav':  'audio/wav',
//   '.aac':  'audio/aac',
//   '.ogg':  'audio/ogg',
//   '.opus': 'audio/ogg; codecs=opus',
//   '.alac': 'audio/mp4',
//   '.aiff': 'audio/aiff',
//   '.wma':  'audio/x-ms-wma',
// };

// // ─── CONFIG (persisted to config.json) ───────────────────────────────────────
// function loadConfig() {
//   try {
//     const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
//     return JSON.parse(raw);
//   } catch (e) {
//     return { musicDirs: [] }; // no config yet — start empty
//   }
// }

// function saveConfig(cfg) {
//   fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
// }

// let config = loadConfig();

// // ─── FILE SCANNING ────────────────────────────────────────────────────────────
// function scanDir(dir, base) {
//   base = base || '';
//   let results = [];
//   let entries;
//   try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
//   catch (e) { return results; }
//   for (const entry of entries) {
//     if (entry.name.startsWith('.')) continue; // skip hidden files/dirs
//     const rel  = path.join(base, entry.name);
//     const full = path.join(dir, entry.name);
//     if (entry.isDirectory()) {
//       results = results.concat(scanDir(full, rel));
//     } else if (AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) {
//       results.push(rel);
//     }
//   }
//   return results;
// }

// // Each source dir gets scanned separately; files are prefixed with source index
// // so the server always knows which root dir a file belongs to.
// // Format: "0/relative/path/to/song.mp3"  where "0" = index into config.musicDirs
// let fileListCache = null;
// let cacheTime = 0;

// function getFileList(force) {
//   const now = Date.now();
//   if (!force && fileListCache && now - cacheTime < 30000) return fileListCache;
//   const results = [];
//   (config.musicDirs || []).forEach((dir, idx) => {
//     const files = scanDir(dir);
//     files.forEach(f => results.push(idx + '/' + f));
//   });
//   fileListCache = results;
//   cacheTime = now;
//   return results;
// }

// // Resolve a prefixed path back to an absolute filesystem path
// function resolveFile(prefixedPath) {
//   const slashIdx = prefixedPath.indexOf('/');
//   if (slashIdx === -1) return null;
//   const idx = parseInt(prefixedPath.slice(0, slashIdx), 10);
//   const rel  = prefixedPath.slice(slashIdx + 1);
//   const dir  = (config.musicDirs || [])[idx];
//   if (!dir) return null;
//   const abs  = path.resolve(path.join(dir, rel));
//   // Security: must stay inside the declared source dir
//   if (!abs.startsWith(path.resolve(dir))) return null;
//   return abs;
// }

// // ─── BODY READER ─────────────────────────────────────────────────────────────
// function readBody(req) {
//   return new Promise((resolve, reject) => {
//     let body = '';
//     req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
//     req.on('end', () => resolve(body));
//     req.on('error', reject);
//   });
// }

// // ─── SERVER ───────────────────────────────────────────────────────────────────
// http.createServer(async (req, res) => {
//   const parsed   = url.parse(req.url, true);
//   const pathname = parsed.pathname;

//   res.setHeader('Access-Control-Allow-Origin',  '*');
//   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//   if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

//   const json = (obj, status) => {
//     res.writeHead(status || 200, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify(obj));
//   };

//   // ── GET /config  →  current music source dirs + status
//   if (pathname === '/config' && req.method === 'GET') {
//     const dirs = (config.musicDirs || []).map(d => ({
//       path:  d,
//       exists: fs.existsSync(d),
//       count:  fs.existsSync(d) ? scanDir(d).length : 0,
//     }));
//     json({ dirs });
//     return;
//   }

//   // ── POST /config/add  →  add a music source dir  { "path": "/some/folder" }
//   if (pathname === '/config/add' && req.method === 'POST') {
//     try {
//       const body = JSON.parse(await readBody(req));
//       const dir  = path.resolve(body.path || '');
//       if (!dir) { json({ error: 'No path provided' }, 400); return; }
//       if (!fs.existsSync(dir)) { json({ error: 'Folder does not exist: ' + dir }, 400); return; }
//       const stat = fs.statSync(dir);
//       if (!stat.isDirectory()) { json({ error: 'Path is not a folder: ' + dir }, 400); return; }
//       if ((config.musicDirs || []).includes(dir)) { json({ error: 'Already added' }, 400); return; }
//       config.musicDirs = config.musicDirs || [];
//       config.musicDirs.push(dir);
//       saveConfig(config);
//       fileListCache = null; // bust cache
//       const count = scanDir(dir).length;
//       console.log('  ♫  Added music source: ' + dir + ' (' + count + ' tracks)');
//       json({ ok: true, path: dir, count });
//     } catch (e) { json({ error: e.message }, 400); }
//     return;
//   }

//   // ── POST /config/remove  →  remove a source dir  { "index": 0 }
//   if (pathname === '/config/remove' && req.method === 'POST') {
//     try {
//       const body = JSON.parse(await readBody(req));
//       const idx  = parseInt(body.index, 10);
//       if (isNaN(idx) || idx < 0 || idx >= (config.musicDirs || []).length) {
//         json({ error: 'Invalid index' }, 400); return;
//       }
//       const removed = config.musicDirs.splice(idx, 1)[0];
//       saveConfig(config);
//       fileListCache = null;
//       console.log('  ♫  Removed music source: ' + removed);
//       json({ ok: true });
//     } catch (e) { json({ error: e.message }, 400); }
//     return;
//   }

//   // ── GET /music  →  JSON list of all tracks (prefixed with source index)
//   if (pathname === '/music' && req.method === 'GET') {
//     if (!config.musicDirs || config.musicDirs.length === 0) {
//       json({ error: 'no_sources', tracks: [] });
//       return;
//     }
//     const force = parsed.query.refresh === '1';
//     json({ tracks: getFileList(force) });
//     return;
//   }

//   // ── GET /file/<prefixed-path>  →  stream audio (supports Range)
//   if (pathname.startsWith('/file/') && req.method === 'GET') {
//     const prefixed = decodeURIComponent(pathname.slice(6));
//     const full     = resolveFile(prefixed);
//     if (!full) { res.writeHead(403); res.end('Forbidden'); return; }

//     let stat;
//     try { stat = fs.statSync(full); }
//     catch (e) { res.writeHead(404); res.end('Not found'); return; }

//     const ext   = path.extname(full).toLowerCase();
//     const mime  = MIME[ext] || 'application/octet-stream';
//     const total = stat.size;
//     const rangeHeader = req.headers['range'];

//     if (rangeHeader) {
//       const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
//       const start = parseInt(startStr, 10);
//       const end   = endStr ? parseInt(endStr, 10) : total - 1;
//       res.writeHead(206, {
//         'Content-Range':  `bytes ${start}-${end}/${total}`,
//         'Accept-Ranges':  'bytes',
//         'Content-Length': end - start + 1,
//         'Content-Type':   mime,
//       });
//       fs.createReadStream(full, { start, end }).pipe(res);
//     } else {
//       res.writeHead(200, {
//         'Content-Length': total,
//         'Accept-Ranges':  'bytes',
//         'Content-Type':   mime,
//       });
//       fs.createReadStream(full).pipe(res);
//     }
//     return;
//   }

//   // ── GET /  →  serve player.html
//   if (pathname === '/' || pathname === '/player.html') {
//     try {
//       const html = fs.readFileSync(PLAYER_PATH);
//       res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
//       res.end(html);
//     } catch (e) {
//       res.writeHead(500); res.end('player.html not found next to server.js');
//     }
//     return;
//   }

//   res.writeHead(404); res.end('Not found');

// }).listen(PORT, '127.0.0.1', () => {
//   console.log('');
//   console.log('  ♫  Squiglink Player  →  http://localhost:' + PORT);
//   if (config.musicDirs && config.musicDirs.length) {
//     config.musicDirs.forEach(d => console.log('  ♫  Source: ' + d));
//   } else {
//     console.log('  ♫  No music sources yet — add one in the web UI.');
//   }
//   console.log('  ♫  Press Ctrl+C to stop.');
//   console.log('');
// });

'use strict';
/**
 * websocket-relay.js  (service: ws-relay)
 * -----------------------------------------------------------------------------
 * Bridges the client's noVNC WebSocket to the per-session browser container's
 * websockify endpoint, resolving the target by session id from the rbi-manager.
 *
 * It also serves a minimal noVNC viewer page at /viewer/<sessionId> so the
 * extension can simply open a tab pointing at the edge host. The actual pixels
 * originate from the container; the client only renders the stream.
 *
 * Routes (through nginx):
 *   GET  /health
 *   GET  /viewer/<sessionId>     -> HTML page that boots the noVNC client
 *   WS   /vnc/<sessionId>        -> upgraded + piped to <container>:6080
 */

const http = require('http');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '9200', 10);
const MANAGER = process.env.RBI_MANAGER_URL || 'http://rbi-manager:9100';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) {
    console.log(`[${new Date().toISOString()}] [${level}] [ws-relay]`, ...args);
  }
}

function resolveSession(id) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${MANAGER}/sessions/${encodeURIComponent(id)}`);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 4000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`session ${id} not found`));
          try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('manager timeout')));
    req.end();
  });
}

// --- noVNC viewer page (self-contained; noVNC lib is bundled in the image) ---
function viewerPage(sessionId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Browsing Session</title>
<style>
  html,body{margin:0;height:100%;background:#0a2342;color:#7fffd4;
    font-family:Montserrat,system-ui,sans-serif;overflow:hidden}
  #status{position:fixed;top:0;left:0;right:0;height:34px;display:flex;
    align-items:center;gap:10px;padding:0 14px;background:#0a2342;
    border-bottom:1px solid rgba(127,255,212,.25);font-size:13px;z-index:5}
  #dot{width:9px;height:9px;border-radius:50%;background:#f5a623;
    box-shadow:0 0 8px #f5a623}
  #dot.ok{background:#7fffd4;box-shadow:0 0 8px #7fffd4}
  #screen{position:fixed;top:34px;left:0;right:0;bottom:0}
  b{font-family:'Playfair Display',Georgia,serif;font-weight:700}
</style></head><body>
<div id="status"><span id="dot"></span><b>Remote Browsing</b>
  <span id="msg">connecting to isolated session…</span></div>
<div id="screen"></div>
<script type="module">
  import RFB from '/viewer/core/rfb.js';
  const dot = document.getElementById('dot');
  const msg = document.getElementById('msg');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = proto + '://' + location.host + '/vnc/${sessionId}';
  let rfb;
  try {
    rfb = new RFB(document.getElementById('screen'), url, { wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener('connect', () => { dot.classList.add('ok'); msg.textContent = 'isolated session live — nothing runs on your machine'; });
    rfb.addEventListener('disconnect', () => { dot.classList.remove('ok'); msg.textContent = 'session ended'; });
  } catch (e) { msg.textContent = 'failed to start viewer: ' + e.message; }
  // Heartbeat keeps the server-side container alive while the tab is open.
  setInterval(() => { fetch('/api/session/${sessionId}/heartbeat', {method:'POST'}).catch(()=>{}); }, 30000);
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'ws-relay' }));
  }
  const m = url.pathname.match(/^\/viewer\/([a-f0-9]{6,})$/i);
  if (m) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(viewerPage(m[1]));
  }
  // Static noVNC files (core/ modules and vendor/ libs like pako) served from disk.
  if (url.pathname.startsWith('/viewer/core/') || url.pathname.startsWith('/viewer/vendor/')) {
    return serveStatic(url.pathname.replace('/viewer/', ''), res);
  }
  res.writeHead(404); res.end('not found');
});

const fs = require('fs');
const path = require('path');
const NOVNC_ROOT = '/opt/novnc';
function serveStatic(rel, res) {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(NOVNC_ROOT, safe);
  if (!file.startsWith(NOVNC_ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// --- WebSocket upgrade: pipe client <-> container websockify ----------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  const m = url.pathname.match(/^\/vnc\/([a-f0-9]{6,})$/i);
  if (!m) { socket.destroy(); return; }
  const sessionId = m[1];

  let target;
  try {
    const sess = await resolveSession(sessionId);
    target = sess.target; // e.g. erv-browser-xxxx:6080
  } catch (e) {
    log('warn', `upgrade rejected for ${sessionId}: ${e.message}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const [host, port] = target.split(':');
    const upstream = new WebSocket(`ws://${host}:${port}/`, ['binary']);

    const pendingToUpstream = [];
    clientWs.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pendingToUpstream.push([data, isBinary]);
    });
    upstream.on('open', () => {
      log('debug', `relay open ${sessionId} -> ${target}`);
      for (const [d, b] of pendingToUpstream) upstream.send(d, { binary: b });
      pendingToUpstream.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });

    const closeBoth = (who) => () => {
      log('debug', `relay closed by ${who} for ${sessionId}`);
      try { clientWs.close(); } catch (_) {}
      try { upstream.close(); } catch (_) {}
    };
    clientWs.on('close', closeBoth('client'));
    upstream.on('close', closeBoth('upstream'));
    clientWs.on('error', closeBoth('client-err'));
    upstream.on('error', closeBoth('upstream-err'));
  });
});

server.listen(PORT, () => log('info', `ws-relay listening on :${PORT}, manager=${MANAGER}`));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
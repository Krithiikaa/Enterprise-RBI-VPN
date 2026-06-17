'use strict';
/**
 * broker.js  (service: session-broker)
 * -----------------------------------------------------------------------------
 * The public front door (sits behind nginx at /api/). Responsibilities:
 *   - Authenticate requests with the shared SESSION_TOKEN (Bearer).
 *   - Enforce capacity policy before asking the rbi-manager to spawn.
 *   - Expose connection status / stats for the extension popup.
 *   - Proxy lifecycle (create / heartbeat / destroy) to the rbi-manager.
 *
 * Public API (via nginx, prefix /api):
 *   GET    /api/status                       -> { ok, active, max, free, uptime }
 *   POST   /api/session                      -> create -> { id, viewerUrl }
 *   POST   /api/session/:id/heartbeat        -> keep-alive
 *   DELETE /api/session/:id                  -> destroy
 *   GET    /api/health                       -> liveness
 */

const express = require('express');
const http = require('http');

const PORT = parseInt(process.env.PORT || '9000', 10);
const MANAGER = process.env.RBI_MANAGER_URL || 'http://rbi-manager:9100';
const TOKEN = process.env.SESSION_TOKEN || '';
const MAX = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '12', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const START = Date.now();

function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) {
    console.log(`[${new Date().toISOString()}] [${level}] [broker]`, ...args);
  }
}

// Minimal JSON HTTP client to the internal manager.
function managerCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MANAGER + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method, timeout: 8000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = buf ? JSON.parse(buf) : {}; } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('manager timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const app = express();
app.use(express.json({ limit: '32kb' }));

// --- auth middleware (everything except health) ------------------------------
function auth(req, res, next) {
  if (!TOKEN) return next(); // auth disabled if no token configured
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (token && timingSafeEqual(token, TOKEN)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function timingSafeEqual(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'session-broker' }));

app.get('/status', auth, async (_req, res) => {
  try {
    const cap = await managerCall('GET', '/capacity');
    res.json({
      ok: true,
      active: cap.body.active ?? 0,
      max: cap.body.max ?? MAX,
      free: cap.body.free ?? MAX,
      uptimeSec: Math.round((Date.now() - START) / 1000),
    });
  } catch (e) {
    log('warn', 'status manager error:', e.message);
    res.status(502).json({ ok: false, error: 'manager_unreachable' });
  }
});

app.post('/session', auth, async (req, res) => {
  try {
    const cap = await managerCall('GET', '/capacity');
    if ((cap.body.free ?? 0) <= 0) {
      return res.status(429).json({ error: 'capacity_reached', max: cap.body.max ?? MAX });
    }
    const out = await managerCall('POST', '/sessions', { startUrl: req.body?.startUrl });
    if (out.status !== 201) {
      return res.status(out.status || 502).json(out.body || { error: 'spawn_failed' });
    }
    log('info', `created session ${out.body.id}`);
    res.status(201).json({
      id: out.body.id,
      viewerUrl: `/viewer/${out.body.id}`,
    });
  } catch (e) {
    log('error', 'create error:', e.message);
    res.status(502).json({ error: 'manager_unreachable' });
  }
});

app.post('/session/:id/heartbeat', async (req, res) => {
  // Token-optional on purpose: called by the in-tab viewer JS. The random
  // session id (>=12 hex chars) is the capability that scopes this call.
  try {
    const out = await managerCall('POST', `/sessions/${encodeURIComponent(req.params.id)}/touch`);
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(502).json({ error: 'manager_unreachable' });
  }
});

app.delete('/session/:id', auth, async (req, res) => {
  try {
    const out = await managerCall('DELETE', `/sessions/${encodeURIComponent(req.params.id)}`);
    log('info', `destroyed session ${req.params.id}`);
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(502).json({ error: 'manager_unreachable' });
  }
});

app.listen(PORT, () => log('info', `session-broker listening on :${PORT}, manager=${MANAGER}, max=${MAX}`));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

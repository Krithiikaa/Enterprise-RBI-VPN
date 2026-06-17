'use strict';
/**
 * session-manager.js  (service: rbi-manager)
 * -----------------------------------------------------------------------------
 * Owns the lifecycle of per-session Remote Browser Isolation containers.
 *
 * HARD GUARANTEE: every browsing session runs inside its own Docker container
 * ON THE SERVER. The client only ever receives a noVNC pixel stream. No page
 * is ever fetched or rendered on the client machine.
 *
 * Internal HTTP API (reachable only on the docker rbi-net network):
 *   POST   /sessions            -> spawn a container, returns { id, container }
 *   DELETE /sessions/:id        -> stop + remove the container
 *   GET    /sessions/:id        -> resolve a session (used by ws-relay)
 *   GET    /sessions            -> list active sessions
 *   GET    /capacity            -> { active, max, free }
 *   POST   /sessions/:id/touch  -> refresh idle timer (heartbeat)
 */

const http = require('http');
const crypto = require('crypto');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PORT = parseInt(process.env.PORT || '9100', 10);
const BROWSER_IMAGE = process.env.BROWSER_IMAGE || 'rbi-browser:latest';
const NETWORK = process.env.RBI_NETWORK_NAME || 'enterprise-rbi-vpn_rbi-net';
const MEM_MB = parseInt(process.env.SESSION_MEM_LIMIT_MB || '380', 10);
const CPU = parseFloat(process.env.SESSION_CPU_QUOTA || '0.5');
const SHM_MB = parseInt(process.env.SESSION_SHM_MB || '256', 10);
const TTL_MS = parseInt(process.env.SESSION_TTL_SECONDS || '1800', 10) * 1000;
const MAX = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '12', 10);
const PROXY_HOST = process.env.PROXY_GATEWAY_HOST || 'proxy-gateway';
const PROXY_PORT = process.env.PROXY_GATEWAY_PORT || '3128';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const NOVNC_PORT = 6080; // websockify port inside the browser container
const LABEL = 'erv.role=rbi-browser';

/** sessionId -> { id, container, name, createdAt, lastSeen, ttlTimer } */
const sessions = new Map();

function log(level, ...args) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  if (order[level] <= order[LOG_LEVEL]) {
    console.log(`[${new Date().toISOString()}] [${level}] [rbi-manager]`, ...args);
  }
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { resolve({}); }
    });
  });
}

async function spawnSession(opts = {}) {
  if (sessions.size >= MAX) {
    const err = new Error('capacity_reached');
    err.code = 'CAPACITY';
    throw err;
  }

  const id = crypto.randomBytes(9).toString('hex');
  const name = `erv-browser-${id}`;
  const startUrl = sanitizeUrl(opts.startUrl) || 'about:blank';

  log('info', `spawning session ${id} (active=${sessions.size + 1}/${MAX})`);

  const container = await docker.createContainer({
    Image: BROWSER_IMAGE,
    name,
    Hostname: name,
    Labels: { 'erv.role': 'rbi-browser', 'erv.session': id },
    Env: [
      `START_URL=${startUrl}`,
      // Route the isolated browser's egress through the company forward proxy.
      `BROWSER_PROXY=http://${PROXY_HOST}:${PROXY_PORT}`,
      'VNC_PORT=5900',
      `NOVNC_PORT=${NOVNC_PORT}`,
      'SCREEN_GEOMETRY=1280x800x24',
    ],
    HostConfig: {
      AutoRemove: true,                       // vanish on stop
      NetworkMode: NETWORK,
      Memory: MEM_MB * 1024 * 1024,
      MemorySwap: MEM_MB * 1024 * 1024,       // disallow swap growth
      NanoCpus: Math.round(CPU * 1e9),
      ShmSize: SHM_MB * 1024 * 1024,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      PidsLimit: 512,
      ReadonlyRootfs: false,
    },
  });

  await container.start();

  const rec = {
    id,
    name,
    container,
    target: `${name}:${NOVNC_PORT}`,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ttlTimer: null,
  };
  armReaper(rec);
  sessions.set(id, rec);
  return { id, container: name, target: rec.target };
}

function armReaper(rec) {
  if (rec.ttlTimer) clearTimeout(rec.ttlTimer);
  rec.ttlTimer = setTimeout(() => {
    log('info', `session ${rec.id} hit TTL, reaping`);
    destroySession(rec.id).catch((e) => log('warn', 'reaper error', e.message));
  }, TTL_MS);
  rec.ttlTimer.unref?.();
}

async function destroySession(id) {
  const rec = sessions.get(id);
  if (!rec) return false;
  sessions.delete(id);
  if (rec.ttlTimer) clearTimeout(rec.ttlTimer);
  try {
    await rec.container.stop({ t: 3 }); // AutoRemove cleans up the container
    log('info', `session ${id} stopped`);
  } catch (e) {
    // Already gone / racing with AutoRemove — force remove as a fallback.
    try { await rec.container.remove({ force: true }); } catch (_) {}
    log('debug', `session ${id} teardown note: ${e.message}`);
  }
  return true;
}

function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch { return null; }
}

/** On boot, sweep any orphaned browser containers from a previous crash. */
async function sweepOrphans() {
  try {
    const list = await docker.listContainers({
      all: true,
      filters: { label: ['erv.role=rbi-browser'] },
    });
    for (const c of list) {
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        log('info', `swept orphan container ${c.Names?.[0]}`);
      } catch (_) {}
    }
  } catch (e) {
    log('warn', 'orphan sweep skipped:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && url.pathname === '/capacity') {
      return json(res, 200, { active: sessions.size, max: MAX, free: Math.max(0, MAX - sessions.size) });
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      return json(res, 200, {
        active: sessions.size,
        sessions: [...sessions.values()].map((s) => ({
          id: s.id, container: s.name, target: s.target,
          ageSec: Math.round((Date.now() - s.createdAt) / 1000),
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = await readBody(req);
      const out = await spawnSession(body);
      return json(res, 201, out);
    }

    if (parts[0] === 'sessions' && parts[1]) {
      const id = parts[1];
      if (req.method === 'GET' && !parts[2]) {
        const rec = sessions.get(id);
        if (!rec) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { id: rec.id, container: rec.name, target: rec.target });
      }
      if (req.method === 'POST' && parts[2] === 'touch') {
        const rec = sessions.get(id);
        if (!rec) return json(res, 404, { error: 'not_found' });
        rec.lastSeen = Date.now();
        armReaper(rec);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const ok = await destroySession(id);
        return json(res, ok ? 200 : 404, { ok });
      }
    }

    return json(res, 404, { error: 'no_route' });
  } catch (e) {
    if (e.code === 'CAPACITY') return json(res, 429, { error: 'capacity_reached', max: MAX });
    log('error', 'request failed:', e.message);
    return json(res, 500, { error: 'internal', detail: e.message });
  }
});

async function shutdown() {
  log('info', 'shutting down, destroying all sessions...');
  await Promise.allSettled([...sessions.keys()].map(destroySession));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

sweepOrphans().finally(() => {
  server.listen(PORT, () => log('info', `rbi-manager listening on :${PORT}, image=${BROWSER_IMAGE}, max=${MAX}`));
});

module.exports = { spawnSession, destroySession, sessions };

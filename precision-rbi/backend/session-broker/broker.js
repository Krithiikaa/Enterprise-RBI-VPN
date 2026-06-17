/**
 * Precision RBI — session-broker  [SRV-05]
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   - POST /api/start-session  -> spawn an RBI container, return { wsUrl, sessionId }
 *   - POST /api/end-session    -> stop + remove the container (teardown path A & part of C)
 *   - POST /api/heartbeat      -> reset the per-session liveness timer (teardown path B input)
 *   - GET  /api/sessions       -> list active sessions (admin)
 *   - GET  /api/sessions/count -> { count }
 *   - GET  /api/health         -> { status, uptime, version, capacity }
 *   - WS   /ws/{sessionId}      -> noVNC bridge; the 'close' event is teardown path C
 *
 * HC-05 three INDEPENDENT teardown mechanisms, all wired below:
 *   (A) extension chrome.tabs.onRemoved -> POST /api/end-session            -> endSession()
 *   (B) heartbeat watchdog: no ping within HEARTBEAT_TIMEOUT_MS -> reaper    -> endSession()
 *   (C) WebSocket 'close' on the viewer bridge                               -> endSession()
 * Each path calls the same idempotent endSession(); whichever fires first wins,
 * the others no-op cleanly. None depends on the others being reached.
 *
 * State of record is Redis (so a broker restart can resume reaping), with an
 * in-process Map as the hot cache. The Docker daemon is the ultimate source of
 * truth and is reconciled on boot.
 */

import express from "express";
import Dockerode from "dockerode";
import Redis from "ioredis";
import { WebSocketServer } from "ws";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";

// --- config ----------------------------------------------------------------
const cfg = {
  port: Number(process.env.PORT || 3001),
  redisUrl: process.env.REDIS_URL || "redis://redis:6379/1",
  rbiImage: process.env.RBI_IMAGE || "precision-rbi/rbi-container",
  rbiNetwork: process.env.RBI_NETWORK || "rbi-net",
  portMin: Number(process.env.HOST_PORT_MIN || 6080),
  portMax: Number(process.env.HOST_PORT_MAX || 6180),
  sessionMemMb: Number(process.env.SESSION_MEM_MB || 1024),
  sessionCpus: Number(process.env.SESSION_CPUS || 0.5),
  heartbeatTimeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS || 30000),
  watchdogIntervalMs: Number(process.env.WATCHDOG_INTERVAL_MS || 10000),
  maxSessions: Number(process.env.MAX_SESSIONS || 4),
  publicHost: process.env.SERVER_PUBLIC_HOST || "localhost",
  version: process.env.APP_VERSION || "0.1.0",
};

const REDIS_PREFIX = "session:";
const log = (...a) => console.log(new Date().toISOString(), "[broker]", ...a);
const warn = (...a) => console.warn(new Date().toISOString(), "[broker]", ...a);

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
const redis = new Redis(cfg.redisUrl, { lazyConnect: false });

/** sessionId -> { containerId, hostPort, userId, userIp, startedAt, lastHeartbeat } */
const sessions = new Map();
/** Set<number> of host ports currently leased. */
const leasedPorts = new Set();
const bootTime = Date.now();

// --- port allocation --------------------------------------------------------
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function allocatePort() {
  for (let p = cfg.portMin; p <= cfg.portMax; p++) {
    if (leasedPorts.has(p)) continue;
    if (await isPortFree(p)) {
      leasedPorts.add(p);
      return p;
    }
  }
  throw new Error("no free host port in range " + cfg.portMin + "-" + cfg.portMax);
}

function releasePort(port) {
  if (port != null) leasedPorts.delete(port);
}

// --- redis persistence helpers ---------------------------------------------
async function persist(sessionId, rec) {
  await redis.set(REDIS_PREFIX + sessionId, JSON.stringify(rec));
}
async function forget(sessionId) {
  await redis.del(REDIS_PREFIX + sessionId);
}

// --- core lifecycle ---------------------------------------------------------
async function startSession({ userId, userIp }) {
  if (sessions.size >= cfg.maxSessions) {
    const err = new Error("capacity_reached");
    err.code = 503;
    throw err;
  }

  const sessionId = randomUUID();
  const hostPort = await allocatePort();
  let container;

  try {
    // RBI container: 6080 (noVNC) inside -> dynamic host port. Hardened: rbi-net
    // only (internal, no LAN egress), tmpfs writes, no extra caps, resource caps.
    container = await docker.createContainer({
      Image: cfg.rbiImage,
      name: "rbi-" + sessionId.slice(0, 8),
      Labels: { "precision-rbi.session": sessionId, "precision-rbi.user": String(userId || "anon") },
      ExposedPorts: { "6080/tcp": {} },
      HostConfig: {
        NetworkMode: cfg.rbiNetwork,
        AutoRemove: true,
        Memory: cfg.sessionMemMb * 1024 * 1024,
        MemorySwap: cfg.sessionMemMb * 1024 * 1024, // disallow swap growth
        NanoCpus: Math.round(cfg.sessionCpus * 1e9),
        PortBindings: { "6080/tcp": [{ HostPort: String(hostPort) }] },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: false, // Chromium needs writable paths; constrained via tmpfs below
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m", "/run": "rw,size=64m" },
      },
    });

    await container.start();

    const rec = {
      sessionId,
      containerId: container.id,
      hostPort,
      userId: userId || "anon",
      userIp: userIp || null,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    sessions.set(sessionId, rec);
    await persist(sessionId, rec);

    // The extension's viewer connects to nginx, which upgrades to this broker's
    // /ws/{id} bridge; the bridge then proxies to the container's noVNC port.
    const wsUrl = `wss://${cfg.publicHost}/rbi/ws/${sessionId}`;
    log(`started ${sessionId} (container ${container.id.slice(0, 12)}, host port ${hostPort}) for ${rec.userId}`);
    return { sessionId, wsUrl, hostPort };
  } catch (e) {
    releasePort(hostPort);
    if (container) { try { await container.remove({ force: true }); } catch { /* AutoRemove may have handled it */ } }
    throw e;
  }
}

/**
 * Idempotent teardown. Safe to call from any of the three paths concurrently.
 * The first call removes the record so subsequent calls short-circuit.
 */
async function endSession(sessionId, reason = "explicit") {
  const rec = sessions.get(sessionId);
  if (!rec) {
    // Not in hot cache; clean any stray redis/docker remnants and return.
    await forget(sessionId);
    return false;
  }
  sessions.delete(sessionId); // claim ownership immediately -> other paths no-op

  try {
    const container = docker.getContainer(rec.containerId);
    // stop() then remove(); AutoRemove usually deletes it, so swallow 404s.
    try { await container.stop({ t: 3 }); } catch (e) { if (e.statusCode !== 304 && e.statusCode !== 404) warn("stop", sessionId, e.message); }
    try { await container.remove({ force: true }); } catch (e) { if (e.statusCode !== 404) warn("remove", sessionId, e.message); }
  } finally {
    releasePort(rec.hostPort);
    await forget(sessionId);
    log(`ended ${sessionId} (reason=${reason}, lived ${(Date.now() - rec.startedAt) / 1000}s)`);
  }
  return true;
}

function heartbeat(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  rec.lastHeartbeat = Date.now();
  persist(sessionId, rec).catch(() => {});
  return true;
}

// --- teardown path B: heartbeat watchdog -----------------------------------
function startWatchdog() {
  setInterval(async () => {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (now - rec.lastHeartbeat > cfg.heartbeatTimeoutMs) {
        warn(`watchdog reaping ${id} (silent ${(now - rec.lastHeartbeat) / 1000}s)`);
        await endSession(id, "heartbeat-timeout").catch((e) => warn("reap", id, e.message));
      }
    }
  }, cfg.watchdogIntervalMs).unref();
}

// --- boot reconciliation: adopt orphans, reap unknowns ----------------------
async function reconcileOnBoot() {
  try {
    const containers = await docker.listContainers({ all: true, filters: { label: ["precision-rbi.session"] } });
    for (const c of containers) {
      const sid = c.Labels["precision-rbi.session"];
      // We lost in-memory state across restart -> these are orphans. Reap them;
      // the extension will simply reconnect/restart a session on next use.
      warn(`boot: reaping orphan container ${c.Id.slice(0, 12)} (session ${sid})`);
      try { await docker.getContainer(c.Id).remove({ force: true }); } catch { /* ignore */ }
      await forget(sid);
    }
  } catch (e) {
    warn("boot reconcile failed (docker socket?):", e.message);
  }
}

// --- HTTP API ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));

app.post("/api/start-session", async (req, res) => {
  try {
    const { userId, userIp } = req.body || {};
    const out = await startSession({ userId, userIp: userIp || req.ip });
    res.json(out);
  } catch (e) {
    if (e.code === 503 || e.message === "capacity_reached") {
      return res.status(503).json({ error: "capacity_reached", maxSessions: cfg.maxSessions });
    }
    warn("start-session", e.message);
    res.status(500).json({ error: "start_failed", detail: e.message });
  }
});

app.post("/api/end-session", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const ended = await endSession(sessionId, "tab-close-or-explicit");
  res.json({ ended });
});

app.post("/api/heartbeat", (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const ok = heartbeat(sessionId);
  if (!ok) return res.status(404).json({ error: "unknown_session" });
  res.json({ ok: true, ttlMs: cfg.heartbeatTimeoutMs });
});

app.get("/api/sessions", (_req, res) => {
  res.json({
    sessions: [...sessions.values()].map((r) => ({
      sessionId: r.sessionId, userId: r.userId, userIp: r.userIp,
      startedAt: r.startedAt, ageSec: Math.round((Date.now() - r.startedAt) / 1000),
      lastHeartbeatAgoSec: Math.round((Date.now() - r.lastHeartbeat) / 1000),
    })),
  });
});

app.get("/api/sessions/count", (_req, res) => res.json({ count: sessions.size }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: cfg.version,
    uptimeSec: Math.round((Date.now() - bootTime) / 1000),
    capacity: { active: sessions.size, max: cfg.maxSessions, pctUsed: Math.round((sessions.size / cfg.maxSessions) * 100) },
  });
});

// --- HTTP server + WebSocket noVNC bridge (teardown path C) -----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const m = (request.url || "").match(/^\/ws\/([0-9a-f-]{36})$/i);
  if (!m) { socket.destroy(); return; }
  const sessionId = m[1];
  const rec = sessions.get(sessionId);
  if (!rec) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }

  wss.handleUpgrade(request, socket, head, (client) => {
    // Bridge client <-> the container's internal noVNC websocket.
    // Container is on rbi-net; reach it by name on its internal 6080.
    const upstreamUrl = `ws://rbi-${sessionId.slice(0, 8)}:6080/websockify`;
    let upstream;
    try {
      // lazy import to keep top clean
      import("ws").then(({ default: WS }) => {
        upstream = new WS(upstreamUrl);
        upstream.on("open", () => log(`ws bridge open ${sessionId}`));
        upstream.on("message", (d) => client.readyState === client.OPEN && client.send(d));
        upstream.on("close", () => client.close());
        upstream.on("error", (e) => { warn("upstream ws", sessionId, e.message); client.close(); });
        client.on("message", (d) => upstream?.readyState === upstream?.OPEN && upstream.send(d));
      });
    } catch (e) {
      warn("bridge setup", e.message);
      client.close();
    }

    // *** Teardown path C: viewer disconnects -> session dies. ***
    client.on("close", () => {
      try { upstream?.close(); } catch { /* ignore */ }
      endSession(sessionId, "ws-disconnect").catch((e) => warn("ws-teardown", e.message));
    });
    client.on("error", () => { try { upstream?.close(); } catch { /* ignore */ } });
  });
});

// --- graceful shutdown: tear down everything we own -------------------------
async function shutdown(sig) {
  log(`${sig} received; tearing down ${sessions.size} session(s)`);
  await Promise.allSettled([...sessions.keys()].map((id) => endSession(id, "broker-shutdown")));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- boot -------------------------------------------------------------------
(async () => {
  await reconcileOnBoot();
  startWatchdog();
  server.listen(cfg.port, "0.0.0.0", () =>
    log(`session-broker up on :${cfg.port} (maxSessions=${cfg.maxSessions}, mem/session=${cfg.sessionMemMb}MB)`)
  );
})();

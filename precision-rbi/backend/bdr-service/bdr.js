/**
 * Precision RBI — bdr-service  [SRV-09]  (port 3002)
 * Browser Detection & Response telemetry sink.
 *  POST /api/bdr-event { type, url, userId, details }  -> log + threshold analysis
 *  GET  /api/bdr-events?page=&limit=                    -> paginated log (admin)
 *  GET  /api/bdr-alerts                                 -> currently flagged users
 *  GET  /health
 * N same-type events from a user within ALERT_WINDOW_MS -> flag (counter in redis).
 * Events are appended to an NDJSON audit file on the audit-data volume.
 */
import http from "node:http";
import Redis from "ioredis";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PORT = Number(process.env.PORT || 3002);
const WINDOW = Number(process.env.ALERT_WINDOW_MS || 300000);
const THRESHOLD = Number(process.env.ALERT_THRESHOLD || 3);
const LOG_FILE = "/data/bdr-events.ndjson";
const VALID = new Set(["CLIPBOARD_ATTEMPT", "SCREENSHOT_ATTEMPT", "CANVAS_READBACK", "PRINT_ATTEMPT",
  "DOWNLOAD_ATTEMPT", "MALICIOUS_EXTENSION", "OAUTH_EXFIL", "KEYSTROKE_HOOK"]);

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379/2");
const log = (...a) => console.log(new Date().toISOString(), "[bdr]", ...a);

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  let d = ""; for await (const c of req) { d += c; if (d.length > 256_000) break; }
  return d ? JSON.parse(d) : {};
}

async function handleEvent(ev) {
  const type = String(ev.type || "").toUpperCase();
  const userId = ev.userId || "anon";
  const record = {
    ts: ev.ts || Date.now(), type, userId,
    url: ev.url || null, details: ev.details || {},
    known: VALID.has(type),
  };
  await appendFile(LOG_FILE, JSON.stringify(record) + "\n").catch((e) => log("append fail", e.message));

  // sliding-window counter
  const key = `bdr:${userId}:${type}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, WINDOW);

  let flagged = false;
  if (count >= THRESHOLD) {
    flagged = true;
    await redis.set(`bdr:flag:${userId}`, JSON.stringify({ type, count, at: Date.now() }), "PX", WINDOW);
    log(`ALERT user=${userId} type=${type} count=${count} (>= ${THRESHOLD})`);
  }
  return { logged: true, count, flagged };
}

async function recentEvents(page, limit) {
  if (!existsSync(LOG_FILE)) return { events: [], total: 0, page, limit };
  const lines = (await readFile(LOG_FILE, "utf8")).trim().split("\n").filter(Boolean);
  const total = lines.length;
  const start = Math.max(0, total - page * limit);
  const end = Math.max(0, total - (page - 1) * limit);
  const events = lines.slice(start, end).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { events, total, page, limit };
}

async function alerts() {
  const keys = await redis.keys("bdr:flag:*");
  const out = [];
  for (const k of keys) {
    const v = await redis.get(k);
    if (v) out.push({ userId: k.split(":").pop(), ...JSON.parse(v) });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/health") return send(res, 200, { status: "ok", window: WINDOW, threshold: THRESHOLD });
    if (u.pathname === "/api/bdr-event" && req.method === "POST") {
      const result = await handleEvent(await readBody(req));
      return send(res, 200, result);
    }
    if (u.pathname === "/api/bdr-events") {
      const page = Math.max(1, Number(u.searchParams.get("page")) || 1);
      const limit = Math.min(200, Number(u.searchParams.get("limit")) || 50);
      return send(res, 200, await recentEvents(page, limit));
    }
    if (u.pathname === "/api/bdr-alerts") return send(res, 200, { alerts: await alerts() });
    send(res, 404, { error: "not found" });
  } catch (e) {
    log("err", e.message); send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => log(`bdr-service on :${PORT}`));

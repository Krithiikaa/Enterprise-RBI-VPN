/**
 * Precision RBI — admin-console server  [SRV-10]
 * Thin Node API + static host for the React dashboard. Aggregates broker, bdr,
 * and ml-engine. HTTP Basic auth (ADMIN_USER / ADMIN_PASS). Air-gapped: the React
 * bundle is built at image-build time and served locally.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const BROKER = process.env.BROKER_URL || "http://session-broker:3001";
const BDR = process.env.BDR_URL || "http://bdr-service:3002";
const ML = process.env.ML_ENGINE_URL || "http://ml-engine:8001";
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASS || "";
const HOST_MEM_MB = Number(process.env.HOST_TOTAL_MEM_MB || 7380);
const SESSION_MEM_MB = Number(process.env.SESSION_MEM_MB || 1024);
const PUBLIC = "/app/public";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const log = (...a) => console.log(new Date().toISOString(), "[admin]", ...a);

function authed(req) {
  if (!PASS) return true; // if no password set, allow (lab). README warns to set one.
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return u === USER && p === PASS;
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
async function up(url, opts) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function serveStatic(req, res) {
  let p = req.url.split("?")[0];
  if (p === "/" || p === "") p = "/index.html";
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    // SPA fallback
    const idx = join(PUBLIC, "index.html");
    if (existsSync(idx)) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(await readFile(idx)); }
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");

  // API requires auth; static assets do not (so the login prompt can render).
  if (u.pathname.startsWith("/api/")) {
    if (!authed(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Precision RBI Admin"' });
      return res.end("auth required");
    }
    try {
      if (u.pathname === "/api/dashboard") {
        const [health, sessions, alerts, mlHealth] = await Promise.all([
          up(`${BROKER}/api/health`), up(`${BROKER}/api/sessions`),
          up(`${BDR}/api/bdr-alerts`), up(`${ML}/health`),
        ]);
        const active = sessions.sessions?.length || 0;
        const usedMb = (active * SESSION_MEM_MB) + 4300; // sessions + service baseline (see ARCH §4)
        return json(res, 200, {
          health, mlHealth, alerts: alerts.alerts || [],
          sessions: sessions.sessions || [],
          capacity: {
            active, max: health.capacity?.max ?? 4,
            ramUsedMb: usedMb, ramTotalMb: HOST_MEM_MB,
            ramPct: Math.round((usedMb / HOST_MEM_MB) * 100),
            warn: active >= ((health.capacity?.max ?? 4) * 0.75),
          },
        });
      }
      if (u.pathname === "/api/events") {
        const page = u.searchParams.get("page") || 1, limit = u.searchParams.get("limit") || 50;
        return json(res, 200, await up(`${BDR}/api/bdr-events?page=${page}&limit=${limit}`));
      }
      if (u.pathname === "/api/end-session" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        return json(res, 200, await up(`${BROKER}/api/end-session`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
        }));
      }
      return json(res, 404, { error: "unknown api" });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  await serveStatic(req, res);
});

server.listen(PORT, () => log(`admin-console on :${PORT}`));

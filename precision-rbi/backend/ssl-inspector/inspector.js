/**
 * Precision RBI — ssl-inspector  [SRV-03]  (port 8090, internal)
 *
 * In this build the proxy-service terminates TLS (via http-mitm-proxy) and can
 * forward decrypted response bodies here for DEEP content inspection. The
 * inspector extracts response features and asks ml-engine for a content-aware
 * verdict, then returns ALLOW/ISOLATE/BLOCK. URL-only scoring is done directly
 * by the proxy for speed; this service is the body-aware path.
 *
 * It holds the SSL-inspection bypass list (cert-pinned / sensitive domains that
 * must NOT be decrypted). The proxy honors the same list before it ever calls here.
 */
import http from "node:http";

const ML_URL = process.env.ML_ENGINE_URL || "http://ml-engine:8001";
const BYPASS = (process.env.BYPASS_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = 8090;
const log = (...a) => console.log(new Date().toISOString(), "[inspector]", ...a);

function bypassed(host = "") {
  return BYPASS.some((b) => (b.startsWith("*.") ? host.endsWith(b.slice(1)) : host === b || host.endsWith("." + b)));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/health") {
    return res.end(JSON.stringify({ status: "ok", bypassCount: BYPASS.length }));
  }

  if (req.url === "/inspect" && req.method === "POST") {
    let body;
    try { body = await readJson(req); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: "bad json" })); }
    const { url, host, headers, body_snippet } = body;

    if (bypassed(host)) {
      return res.end(JSON.stringify({ decision: "ALLOW", score: 0, category: "TRUSTED", reason: "bypass-listed (not decrypted)", bypassed: true }));
    }

    // Trim the snippet so we send the scorer something bounded.
    const snippet = (body_snippet || "").slice(0, 8000);
    try {
      const r = await fetch(`${ML_URL}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, headers, body_snippet: snippet }),
        signal: AbortSignal.timeout(4000),
      });
      const verdict = await r.json();
      return res.end(JSON.stringify(verdict));
    } catch (e) {
      log("ml error, fail-open:", e.message);
      return res.end(JSON.stringify({ decision: "ALLOW", score: 0, category: "UNKNOWN", reason: "scorer-unavailable" }));
    }
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => log(`ssl-inspector on :${PORT} (bypass: ${BYPASS.length} domains)`));

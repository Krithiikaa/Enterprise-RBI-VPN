/**
 * Precision RBI — proxy-service  [SRV-02]
 * - :8080  inline MITM proxy (HTTP + HTTPS via CONNECT)
 * - :8888  PAC server + CA cert download (/ca.crt)
 * - :8081  thin REST for the popup risk badge (/score?url=...)
 *
 * Per request: extract URL -> ml-engine /score -> ALLOW | ISOLATE | BLOCK.
 * BLOCK returns a styled page. ISOLATE returns an interstitial that hands off to
 * the extension to launch an RBI session. Bypass domains skip inspection.
 *
 * CA NOTE (see ARCHITECTURE §3): http-mitm-proxy generates a CA under ./ca. For
 * HTTPS interception the client must trust ./ca/certs/ca.pem — that trust must be
 * installed via OS/MDM on managed devices; the extension cannot do it silently.
 */
import { Proxy } from "http-mitm-proxy";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cfg = {
  proxyPort: Number(process.env.PROXY_PORT || 8080),
  pacPort: Number(process.env.PAC_PORT || 8888),
  apiPort: 8081,
  mlUrl: process.env.ML_ENGINE_URL || "http://ml-engine:8001",
  brokerUrl: process.env.BROKER_URL || "http://session-broker:3001",
  publicHost: process.env.SERVER_PUBLIC_HOST || "localhost",
  isolate: Number(process.env.ISOLATE_THRESHOLD || 50),
  block: Number(process.env.BLOCK_THRESHOLD || 80),
  bypass: (process.env.BYPASS_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  caDir: "/ca",
};

const log = (...a) => console.log(new Date().toISOString(), "[proxy]", ...a);

function isBypassed(host) {
  return cfg.bypass.some((b) =>
    b.startsWith("*.") ? host.endsWith(b.slice(1)) : host === b || host.endsWith("." + b)
  );
}

async function scoreUrl(url, bodySnippet) {
  try {
    const res = await fetch(`${cfg.mlUrl}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, body_snippet: bodySnippet }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error("ml " + res.status);
    return await res.json();
  } catch (e) {
    // Fail-open to ALLOW but log; an unreachable scorer must not break browsing.
    log("score error, failing open:", e.message);
    return { score: 0, category: "UNKNOWN", decision: "ALLOW", reason: "scorer-unavailable" };
  }
}

function blockPage(url, verdict) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Blocked</title>
<style>body{background:#0a2342;color:#e8f4f8;font-family:system-ui;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}.c{max-width:480px;
text-align:center;padding:32px;border:.5px solid rgba(168,216,234,.2);border-radius:16px;
background:#0d3b6e}h1{color:#d85a30}code{color:#7fffd4;word-break:break-all}</style></head>
<body><div class="c"><h1>⛔ Blocked by Precision RBI</h1>
<p>This page was blocked (risk score <b>${verdict.score}</b>, ${verdict.category}).</p>
<p style="color:#a8d8ea;font-size:13px">${verdict.reason}</p>
<code>${url}</code></div></body></html>`;
}

function isolatePage(url, verdict) {
  // Hands off to the extension content-script/popup, which calls START_SESSION.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Isolating…</title>
<style>body{background:#0a2342;color:#e8f4f8;font-family:system-ui;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}.c{max-width:480px;
text-align:center}.ring{width:48px;height:48px;border:3px solid rgba(127,255,212,.2);
border-top-color:#7fffd4;border-radius:50%;animation:s .8s linear infinite;margin:0 auto 18px}
@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><div class="c"><div class="ring"></div>
<h2>Opening in isolated browser…</h2>
<p style="color:#a8d8ea">Risk ${verdict.score} (${verdict.category}). Click the Precision RBI icon → Start Remote Session.</p>
</div><script>window.postMessage({__precisionRbi:"ISOLATE_REQUEST",url:${JSON.stringify(url)}},"*");</script>
</body></html>`;
}

// --- MITM proxy -------------------------------------------------------------
const proxy = new Proxy();

proxy.onError((ctx, err) => {
  log("proxy error:", err?.code || err?.message);
});

proxy.onRequest(async (ctx, callback) => {
  const host = ctx.clientToProxyRequest.headers.host || "";
  const scheme = ctx.isSSL ? "https" : "http";
  const url = `${scheme}://${host}${ctx.clientToProxyRequest.url}`;

  if (isBypassed(host)) return callback(); // tunnel/forward untouched

  const verdict = await scoreUrl(url);
  // audit line (admin-console tails these from stdout / can be shipped to a sink)
  log(`DECISION ${verdict.decision} score=${verdict.score} ${url}`);

  if (verdict.decision === "BLOCK") {
    ctx.proxyToClientResponse.writeHead(403, { "Content-Type": "text/html" });
    ctx.proxyToClientResponse.end(blockPage(url, verdict));
    return; // do not call callback -> request not forwarded
  }
  if (verdict.decision === "ISOLATE") {
    ctx.proxyToClientResponse.writeHead(200, { "Content-Type": "text/html" });
    ctx.proxyToClientResponse.end(isolatePage(url, verdict));
    return;
  }
  return callback(); // ALLOW -> forward upstream
});

proxy.listen({ port: cfg.proxyPort, sslCaDir: cfg.caDir }, () =>
  log(`MITM proxy on :${cfg.proxyPort} (CA in ${cfg.caDir})`)
);

// --- PAC server + CA download ----------------------------------------------
const pacBody = `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "127.*") || shExpMatch(host, "localhost")) return "DIRECT";
  return "PROXY ${cfg.publicHost}:${cfg.proxyPort}; DIRECT";
}`;

http.createServer((req, res) => {
  if (req.url === "/pac.js" || req.url === "/pac") {
    res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig" });
    return res.end(pacBody);
  }
  if (req.url === "/ca.crt" || req.url === "/ca.pem") {
    const caPath = join(cfg.caDir, "certs", "ca.pem");
    if (existsSync(caPath)) {
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=precision-rbi-ca.crt" });
      return res.end(readFileSync(caPath));
    }
    res.writeHead(404); return res.end("CA not generated yet — send one HTTPS request through the proxy first.");
  }
  res.writeHead(404); res.end("not found");
}).listen(cfg.pacPort, () => log(`PAC + CA server on :${cfg.pacPort}`));

// --- thin score API for the popup badge ------------------------------------
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/score") {
    const target = u.searchParams.get("url");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    if (!target) return res.end(JSON.stringify({ error: "url required" }));
    return res.end(JSON.stringify(await scoreUrl(target)));
  }
  res.writeHead(404); res.end();
}).listen(cfg.apiPort, () => log(`score API on :${cfg.apiPort}`));

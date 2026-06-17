/**
 * Precision RBI — background service worker  [EXT-01]
 * ---------------------------------------------------------------------------
 * MV3 service worker. Responsibilities:
 *   - VPN toggle ON  -> chrome.proxy.settings.set() with a PAC that routes traffic
 *                        through the server's proxy-service.
 *   - VPN toggle OFF -> chrome.proxy.settings.clear().
 *   - 30s heartbeat to /api/heartbeat (keeps the server-side session alive).
 *   - Reconnect with exponential backoff: 1s -> 2s -> 4s -> 8s -> cap 30s.
 *   - chrome.tabs.onRemoved -> POST /api/end-session   (HC-05 teardown path A).
 *   - chrome.alarms keep-alive so the SW isn't evicted after 5 min idle (HC-09).
 *
 * IMPORTANT — TLS interception caveat (see README / ARCHITECTURE §3):
 *   The PAC routes traffic to the proxy, but Chrome provides NO extension API to
 *   install the proxy's CA into the trust store. Plain HTTP and the RBI pixel path
 *   work with zero client config. Full HTTPS *inspection* of non-isolated sites
 *   requires the CA to be trusted via OS/MDM. This worker does not — and cannot —
 *   silently import a root cert. It degrades gracefully: risky sites are isolated
 *   server-side (no client cert needed); inspected HTTPS requires managed deploy.
 */

const STORAGE = chrome.storage.session;  // ephemeral runtime state
const SYNC = chrome.storage.sync;        // user config (server IP/port, policy)

const ALARM_KEEPALIVE = "rbi-keepalive";
const ALARM_HEARTBEAT = "rbi-heartbeat";
const HEARTBEAT_PERIOD_MIN = 0.5;        // 30s (chrome.alarms min granularity is 0.5m on older builds)
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

// --- config access ----------------------------------------------------------
async function getConfig() {
  const c = await SYNC.get({ serverHost: "", serverPort: 443, isolationMode: "smart", riskThreshold: 50 });
  return c;
}
function baseUrl(cfg) {
  if (!cfg.serverHost) return null;
  const port = Number(cfg.serverPort) || 443;
  const scheme = port === 80 ? "http" : "https";
  return `${scheme}://${cfg.serverHost}${(port === 443 || port === 80) ? "" : ":" + port}`;
}

// --- PAC-based proxy control [EXT-01] --------------------------------------
function buildPac(cfg) {
  // Routes everything through proxy-service (nginx exposes it on /proxy upstream,
  // but PAC needs host:port — we point straight at the proxy host:port).
  // The proxy host is the server; the proxy listens on PROXY_PORT (8080) behind
  // nginx stream passthrough, or directly if you expose 8080. Here we target the
  // public host on the proxy port advertised by the server.
  const proxyHost = cfg.serverHost;
  const proxyPort = cfg.proxyPort || 8080;
  return `
function FindProxyForURL(url, host) {
  // Local / RFC1918 stays direct so the extension can still reach the server APIs
  // and so on-LAN resources don't loop through the proxy.
  if (isPlainHostName(host) ||
      shExpMatch(host, "10.*") ||
      shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "172.16.*") ||
      shExpMatch(host, "127.*") ||
      shExpMatch(host, "localhost")) {
    return "DIRECT";
  }
  return "PROXY ${proxyHost}:${proxyPort}; DIRECT";
}`.trim();
}

async function enableProxy() {
  const cfg = await getConfig();
  if (!cfg.serverHost) throw new Error("Server not configured. Open Options and set the server IP.");
  const pacScript = buildPac({ ...cfg, proxyPort: cfg.proxyPort || 8080 });
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: pacScript } },
    scope: "regular",
  });
  await STORAGE.set({ vpnState: "on" });
  await updateBadge("on");
  return true;
}

async function disableProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
  await STORAGE.set({ vpnState: "off" });
  await updateBadge("off");
  return true;
}

async function updateBadge(state) {
  await chrome.action.setBadgeText({ text: state === "on" ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: state === "on" ? "#1D9E75" : "#0a2342" });
}

// --- heartbeat with exponential backoff ------------------------------------
let backoffIdx = 0;

async function sendHeartbeat() {
  const { sessionToken } = await STORAGE.get({ sessionToken: null });
  const cfg = await getConfig();
  const base = baseUrl(cfg);
  if (!base) return;

  // Even without an active RBI session we ping /api/health to drive the latency
  // badge and detect server availability. With a session, we ping heartbeat.
  const url = sessionToken ? `${base}/rbi/api/heartbeat` : `${base}/rbi/api/health`;
  const body = sessionToken ? JSON.stringify({ sessionId: sessionToken }) : undefined;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: sessionToken ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(8000),
    });
    const latency = Math.round(performance.now() - t0);
    if (!res.ok && res.status === 404 && sessionToken) {
      // Server says our session is gone -> drop it, stop pretending we have one.
      await STORAGE.remove("sessionToken");
    }
    await STORAGE.set({ lastPingMs: latency, serverReachable: true, lastPingAt: Date.now() });
    backoffIdx = 0; // success resets backoff
  } catch (e) {
    await STORAGE.set({ serverReachable: false });
    scheduleBackoffRetry();
  }
}

function scheduleBackoffRetry() {
  const delay = BACKOFF_STEPS[Math.min(backoffIdx, BACKOFF_STEPS.length - 1)];
  backoffIdx++;
  setTimeout(() => { sendHeartbeat(); }, delay);
}

// --- RBI session control ----------------------------------------------------
async function startRemoteSession() {
  const cfg = await getConfig();
  const base = baseUrl(cfg);
  if (!base) throw new Error("Server not configured.");
  const res = await fetch(`${base}/rbi/api/start-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: await getUserId() }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 503) throw new Error("Server at capacity — try again shortly.");
  if (!res.ok) throw new Error("Failed to start session (" + res.status + ")");
  const { sessionId, wsUrl } = await res.json();
  await STORAGE.set({ sessionToken: sessionId });

  // Open the viewer tab; pass connection info via the URL hash (stays client-side).
  const viewerUrl = chrome.runtime.getURL("rbi-viewer/viewer.html") +
    "#" + encodeURIComponent(JSON.stringify({ sessionId, wsUrl }));
  const tab = await chrome.tabs.create({ url: viewerUrl });
  await STORAGE.set({ viewerTabId: tab.id });
  return { sessionId, wsUrl, tabId: tab.id };
}

async function endRemoteSession(reason = "explicit") {
  const { sessionToken } = await STORAGE.get({ sessionToken: null });
  if (!sessionToken) return;
  const cfg = await getConfig();
  const base = baseUrl(cfg);
  await STORAGE.remove(["sessionToken", "viewerTabId"]);
  if (!base) return;
  // Fire-and-forget; the server-side watchdog + WS-close are independent backups.
  try {
    await fetch(`${base}/rbi/api/end-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionToken, reason }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* watchdog (path B) will reap it */ }
}

async function getUserId() {
  const { userId } = await STORAGE.get({ userId: null });
  if (userId) return userId;
  const id = "u-" + crypto.randomUUID().slice(0, 8);
  await STORAGE.set({ userId: id });
  return id;
}

// --- BDR telemetry forwarding (from content scripts, EXT-02) ---------------
async function forwardBdr(event) {
  if (!event?.type) return;
  const cfg = await getConfig();
  const base = baseUrl(cfg);
  if (!base) return;
  try {
    await fetch(`${base}/api/bdr-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...event, userId: await getUserId(), ts: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-critical telemetry; drop on failure */ }
}

// --- explicit heartbeat passthrough (from viewer, EXT-05) ------------------
async function heartbeat(sessionId) {
  if (!sessionId) return;
  const cfg = await getConfig();
  const base = baseUrl(cfg);
  if (!base) return;
  try {
    await fetch(`${base}/rbi/api/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* watchdog backstops */ }
}

// --- teardown path A: tab close --------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { viewerTabId } = await STORAGE.get({ viewerTabId: null });
  if (tabId === viewerTabId) {
    await endRemoteSession("tab-closed");
  }
});

// --- keep-alive + heartbeat scheduling (HC-09) ------------------------------
chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });   // ~24s, < 5min eviction
chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: HEARTBEAT_PERIOD_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) sendHeartbeat();
  if (alarm.name === ALARM_KEEPALIVE) { /* waking the SW is itself the keep-alive */ }
});

// --- message bridge from popup / options / viewer ---------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "VPN_ON": sendResponse({ ok: await enableProxy() }); break;
        case "VPN_OFF": sendResponse({ ok: await disableProxy() }); break;
        case "VPN_STATE": {
          const { vpnState } = await STORAGE.get({ vpnState: "off" });
          sendResponse({ vpnState });
          break;
        }
        case "START_SESSION": sendResponse({ ok: true, ...(await startRemoteSession()) }); break;
        case "END_SESSION": await endRemoteSession(msg.reason || "popup"); sendResponse({ ok: true }); break;
        case "HEARTBEAT": { heartbeat(msg.sessionId); sendResponse({ ok: true }); break; }
        case "BDR_FORWARD": { forwardBdr(msg.event); sendResponse({ ok: true }); break; }
        case "STATUS": {
          const s = await STORAGE.get({ vpnState: "off", lastPingMs: null, serverReachable: false, sessionToken: null });
          sendResponse(s);
          break;
        }
        default: sendResponse({ ok: false, error: "unknown_message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// --- boot -------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge((await STORAGE.get({ vpnState: "off" })).vpnState);
});
chrome.runtime.onStartup.addListener(() => sendHeartbeat());

'use strict';
/* =============================================================================
   Aegis background service worker (MV3)
   - Configures chrome.proxy on VPN toggle (HTTP proxy; HTTPS via CONNECT, so
     no certificate is ever required on the client).
   - Creates remote browsing sessions and opens the server-rendered viewer.
   - Tears the session down when the tab closes or routing is turned off.
   - Re-applies routing on startup and retries when the gateway drops.
   ============================================================================= */

const DEFAULTS = { edgePort: 8080, proxyPort: 3128 };
const STORE_KEYS = ['edgeHost', 'edgePort', 'proxyHost', 'proxyPort', 'token', 'vpnOn'];

// tabId -> sessionId   (so closing the tab destroys the server container)
const tabSessions = new Map();

// ---- config helpers ---------------------------------------------------------
async function getConfig() {
  const c = await chrome.storage.local.get(STORE_KEYS);
  return {
    edgeHost: c.edgeHost || '',
    edgePort: c.edgePort || DEFAULTS.edgePort,
    proxyHost: c.proxyHost || c.edgeHost || '',
    proxyPort: c.proxyPort || DEFAULTS.proxyPort,
    token: c.token || '',
    vpnOn: Boolean(c.vpnOn),
    configured: Boolean(c.edgeHost),
  };
}

function apiBase(cfg) { return `http://${cfg.edgeHost}:${cfg.edgePort}`; }

function authHeaders(cfg) {
  return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ---- proxy (the "VPN") ------------------------------------------------------
async function applyProxy(cfg) {
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'http', host: cfg.proxyHost, port: Number(cfg.proxyPort) },
      // Never loop the gateway/API/viewer traffic back through the proxy.
      bypassList: ['localhost', '127.0.0.1', '[::1]', '<local>', cfg.edgeHost],
    },
  };
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  await chrome.action.setBadgeText({ text: 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#7fffd4' });
}

async function clearProxy() {
  // Full restore — leaves no proxy override behind.
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await chrome.action.setBadgeText({ text: '' });
}

async function setVpn(on) {
  const cfg = await getConfig();
  if (!cfg.configured) return { ok: false, error: 'Set a gateway in Settings first.' };
  try {
    if (on) await applyProxy(cfg); else await clearProxy();
    await chrome.storage.local.set({ vpnOn: on });
    return { ok: true, vpnOn: on };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- status -----------------------------------------------------------------
async function getStatus() {
  const cfg = await getConfig();
  if (!cfg.configured) return { ok: false, reason: 'unconfigured' };
  const t0 = performance.now();
  try {
    const res = await fetchWithTimeout(`${apiBase(cfg)}/api/status`, { headers: authHeaders(cfg) }, 5000);
    const pingMs = Math.round(performance.now() - t0);
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const body = await res.json();
    return { ok: true, pingMs, active: body.active, max: body.max, free: body.free };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

// ---- remote session lifecycle ----------------------------------------------
async function openRemote() {
  const cfg = await getConfig();
  if (!cfg.configured) return { ok: false, error: 'Set a gateway in Settings first.' };
  try {
    const res = await fetchWithTimeout(`${apiBase(cfg)}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({}),
    }, 12000);

    if (res.status === 429) return { ok: false, error: 'Server at capacity.' };
    if (res.status === 401) return { ok: false, error: 'Unauthorized — check token in Settings.' };
    if (!res.ok) return { ok: false, error: 'Server error (' + res.status + ').' };

    const body = await res.json();
    const viewerUrl = `${apiBase(cfg)}${body.viewerUrl}`;
    const tab = await chrome.tabs.create({ url: viewerUrl });
    tabSessions.set(tab.id, body.id);
    ensureHeartbeat();
    return { ok: true, tabId: tab.id, sessionId: body.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function destroySession(sessionId) {
  const cfg = await getConfig();
  if (!cfg.configured || !sessionId) return;
  try {
    await fetchWithTimeout(`${apiBase(cfg)}/api/session/${sessionId}`, {
      method: 'DELETE', headers: authHeaders(cfg),
    }, 5000);
  } catch (_) { /* server-side reaper will catch it via TTL */ }
}

// Closing the remote tab destroys the server-side container (graceful teardown).
chrome.tabs.onRemoved.addListener((tabId) => {
  const sessionId = tabSessions.get(tabId);
  if (sessionId) {
    tabSessions.delete(tabId);
    destroySession(sessionId);
    if (tabSessions.size === 0) chrome.alarms.clear('heartbeat');
  }
});

// ---- heartbeat keeps live sessions from being reaped ------------------------
function ensureHeartbeat() {
  chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    const cfg = await getConfig();
    if (!cfg.configured || tabSessions.size === 0) return;
    for (const sessionId of tabSessions.values()) {
      fetchWithTimeout(`${apiBase(cfg)}/api/session/${sessionId}/heartbeat`,
        { method: 'POST', headers: authHeaders(cfg) }, 4000).catch(() => {});
    }
  }
  if (alarm.name === 'reconnect') reapplyIfNeeded();
});

// ---- reconnection / resilience ---------------------------------------------
async function reapplyIfNeeded() {
  const cfg = await getConfig();
  if (cfg.configured && cfg.vpnOn) {
    try { await applyProxy(cfg); } catch (_) {}
  }
}

chrome.proxy.onProxyError.addListener((details) => {
  console.warn('[aegis] proxy error:', details.error, details.details);
  // Schedule a re-apply shortly; transient gateway blips self-heal.
  chrome.alarms.create('reconnect', { delayInMinutes: 0.2 });
});

chrome.runtime.onStartup.addListener(reapplyIfNeeded);
chrome.runtime.onInstalled.addListener(reapplyIfNeeded);

// ---- message router (from popup + options) ----------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GET_STATE': {
        const cfg = await getConfig();
        sendResponse({
          configured: cfg.configured, host: cfg.edgeHost, port: cfg.edgePort,
          proxyHost: cfg.proxyHost, proxyPort: cfg.proxyPort, vpnOn: cfg.vpnOn,
        });
        break;
      }
      case 'GET_STATUS': sendResponse(await getStatus()); break;
      case 'SET_VPN': sendResponse(await setVpn(Boolean(msg.on))); break;
      case 'OPEN_REMOTE': sendResponse(await openRemote()); break;
      case 'TEST_GATEWAY': {
        // Used by the options page "Test connection" button.
        sendResponse(await getStatus());
        break;
      }
      default: sendResponse({ ok: false, error: 'unknown_message' });
    }
  })();
  return true; // async response
});

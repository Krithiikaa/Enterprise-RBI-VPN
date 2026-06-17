/* Precision RBI — options logic  [EXT-04] */
const $ = (id) => document.getElementById(id);
const FIELDS = {
  serverHost: "text", serverPort: "number", proxyPort: "number",
  isolationMode: "select", riskThreshold: "range",
  dlpBlockClipboard: "check", dlpBlockDownload: "check", dlpBlockPrint: "check", dlpWatermark: "check",
};
const DEFAULTS = {
  serverHost: "", serverPort: 443, proxyPort: 8080,
  isolationMode: "smart", riskThreshold: 50,
  dlpBlockClipboard: false, dlpBlockDownload: false, dlpBlockPrint: false, dlpWatermark: true,
};

function baseUrl() {
  const host = $("serverHost").value.trim();
  const port = Number($("serverPort").value) || 443;
  if (!host) return null;
  const scheme = port === 80 ? "http" : "https";
  return `${scheme}://${host}${[80, 443].includes(port) ? "" : ":" + port}`;
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (c) => {
    for (const [id, kind] of Object.entries(FIELDS)) {
      const el = $(id);
      if (kind === "check") el.checked = c[id];
      else el.value = c[id];
    }
    $("thresholdVal").textContent = c.riskThreshold;
  });
}

function save() {
  const out = {};
  for (const [id, kind] of Object.entries(FIELDS)) {
    const el = $(id);
    out[id] = kind === "check" ? el.checked : kind === "number" || kind === "range" ? Number(el.value) : el.value;
  }
  chrome.storage.sync.set(out, () => {
    const m = $("saveMsg"); m.classList.add("show");
    setTimeout(() => m.classList.remove("show"), 1600);
  });
}

async function testConnection() {
  const base = baseUrl();
  const out = $("testResult");
  if (!base) { out.textContent = "Set a server IP first"; out.style.color = "var(--danger)"; return; }
  out.textContent = "Testing…"; out.style.color = "var(--text-dim)";
  try {
    const r = await fetch(`${base}/rbi/api/health`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(r.status);
    const h = await r.json();
    out.textContent = `✓ Online · v${h.version}`; out.style.color = "var(--success)";
    $("srvVersion").textContent = h.version || "—";
    $("srvUsers").textContent = h.capacity?.active ?? "—";
    $("srvUptime").textContent = h.uptimeSec ? fmtUptime(h.uptimeSec) : "—";
  } catch (e) {
    out.textContent = "✗ Unreachable"; out.style.color = "var(--danger)";
  }
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

$("riskThreshold").addEventListener("input", (e) => ($("thresholdVal").textContent = e.target.value));
$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testConnection);
load();

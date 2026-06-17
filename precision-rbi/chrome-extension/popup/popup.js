/* Precision RBI — popup logic  [EXT-03] */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const ringWrap = document.querySelector(".ring-wrap");
let vpnOn = false;

function setVpnUi(state) {
  ringWrap.classList.remove("on", "connecting");
  const status = $("vpnStatus"), sub = $("vpnSub"), toggle = $("vpnToggle");
  if (state === "on") {
    ringWrap.classList.add("on");
    status.textContent = "Protected"; status.className = "status on";
    sub.textContent = "Traffic routed through the secure gateway. No manual proxy setup needed.";
    toggle.setAttribute("aria-pressed", "true"); vpnOn = true;
  } else if (state === "connecting") {
    ringWrap.classList.add("connecting");
    status.textContent = "Connecting…"; status.className = "status connecting";
    sub.textContent = "Applying proxy configuration…";
  } else {
    status.textContent = "Protection Off"; status.className = "status off";
    sub.textContent = "Toggle to route traffic through the secure gateway";
    toggle.setAttribute("aria-pressed", "false"); vpnOn = false;
  }
}

async function refreshStatus() {
  const s = await send({ type: "STATUS" });
  if (!s) return;
  setVpnUi(s.vpnState || "off");
  $("ping").textContent = s.lastPingMs ?? "—";
  $("serverDot").className = "dot " + (s.serverReachable ? "up" : "down");
  $("serverText").textContent = s.serverReachable ? "Gateway online" : "Gateway unreachable";
}

async function refreshSessions() {
  try {
    const cfg = await chrome.storage.sync.get({ serverHost: "", serverPort: 443 });
    if (!cfg.serverHost) return;
    const scheme = Number(cfg.serverPort) === 80 ? "http" : "https";
    const base = `${scheme}://${cfg.serverHost}${[80,443].includes(Number(cfg.serverPort)) ? "" : ":" + cfg.serverPort}`;
    const r = await fetch(`${base}/rbi/api/sessions/count`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) $("sessions").textContent = (await r.json()).count;
  } catch { /* gateway down -> leave dash */ }
}

async function refreshRisk() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) { $("risk").textContent = "—"; return; }
    const cfg = await chrome.storage.sync.get({ serverHost: "", serverPort: 443 });
    if (!cfg.serverHost) return;
    const scheme = Number(cfg.serverPort) === 80 ? "http" : "https";
    const base = `${scheme}://${cfg.serverHost}${[80,443].includes(Number(cfg.serverPort)) ? "" : ":" + cfg.serverPort}`;
    const r = await fetch(`${base}/proxy/score?url=${encodeURIComponent(tab.url)}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const { score } = await r.json();
      const el = $("risk"); el.textContent = score;
      el.className = "risk-badge " + (score >= 80 ? "risk-high" : score >= 50 ? "risk-med" : "risk-low");
    }
  } catch { /* ignore */ }
}

// --- events ---
$("vpnToggle").addEventListener("click", async () => {
  if (vpnOn) {
    await send({ type: "VPN_OFF" });
    setVpnUi("off");
  } else {
    setVpnUi("connecting");
    const res = await send({ type: "VPN_ON" });
    if (res?.ok) setVpnUi("on");
    else { setVpnUi("off"); $("vpnSub").textContent = res?.error || "Failed — check server IP in Settings."; }
  }
});

$("startSession").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.querySelector(".spinner").hidden = false;
  btn.querySelector(".btn-label").textContent = "Launching…";
  const res = await send({ type: "START_SESSION" });
  if (!res?.ok) {
    btn.querySelector(".btn-label").textContent = res?.error || "Failed";
    setTimeout(() => { btn.querySelector(".btn-label").textContent = "Start Remote Session"; btn.disabled = false; btn.querySelector(".spinner").hidden = true; }, 2500);
  } else {
    window.close(); // viewer tab opened
  }
});

$("isolatePage").addEventListener("click", async () => {
  // Manual override: same as start session; the viewer can navigate to current tab URL.
  await send({ type: "START_SESSION" });
  window.close();
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// --- init + light polling while popup open ---
refreshStatus(); refreshSessions(); refreshRisk();
const poll = setInterval(() => { refreshStatus(); refreshSessions(); }, 3000);
window.addEventListener("unload", () => clearInterval(poll));

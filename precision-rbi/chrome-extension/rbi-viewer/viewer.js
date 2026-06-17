/* Precision RBI — RBI viewer  [EXT-05]
 * Connects to the broker's WS bridge via noVNC RFB. Only pixels + input cross
 * the boundary (HC-01). Turbo = WebGL2 present -> noVNC uses higher quality/fps. */
import RFB from "./novnc/core/rfb.js";

const params = (() => {
  try { return JSON.parse(decodeURIComponent(location.hash.slice(1))); }
  catch { return {}; }
})();

const overlay = document.getElementById("overlay");
const overlayMsg = document.getElementById("overlayMsg");
const screen = document.getElementById("screen");
const modeBadge = document.getElementById("modeBadge");
let rfb = null, startTime = null, timerInt = null;

function fail(msg) {
  overlay.classList.remove("hidden");
  overlay.classList.add("err");
  overlayMsg.textContent = msg;
}

// WebGL Turbo auto-detection [EXT-05]
function detectTurbo() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    return !!gl;
  } catch { return false; }
}

function startTimer() {
  startTime = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    document.getElementById("timer").textContent = `${mm}:${ss}`;
  }, 1000);
}

async function endSession(reason) {
  clearInterval(timerInt);
  try { rfb?.disconnect(); } catch {}
  // Path A backup: ask the SW to tell the broker. (WS close = path C is primary here.)
  try { await chrome.runtime.sendMessage({ type: "END_SESSION", reason }); } catch {}
}

function connect() {
  if (!params.wsUrl) { fail("Missing session details. Close this tab and retry."); return; }

  const turbo = detectTurbo();
  modeBadge.textContent = turbo ? "WebGL Turbo" : "Standard";
  modeBadge.classList.toggle("turbo", turbo);

  rfb = new RFB(screen, params.wsUrl, {
    // credentials handled server-side; the bridge auths to the container's VNC.
    shared: true,
    wsProtocols: ["binary"],
  });

  // Turbo: prefer quality + full color; Standard: lower quality JPEG-ish path.
  rfb.qualityLevel = turbo ? 8 : 4;
  rfb.compressionLevel = turbo ? 2 : 6;
  rfb.resizeSession = true;
  rfb.scaleViewport = true;
  rfb.focusOnClick = true;

  rfb.addEventListener("connect", () => {
    overlay.classList.add("hidden");
    startTimer();
  });
  rfb.addEventListener("disconnect", (e) => {
    if (!e.detail?.clean) fail("Session ended unexpectedly.");
    clearInterval(timerInt);
  });
  rfb.addEventListener("securityfailure", () => fail("Session authentication failed."));
}

// Heartbeat from the viewer too (belt-and-suspenders for path B liveness).
setInterval(() => {
  if (params.sessionId) chrome.runtime.sendMessage({ type: "HEARTBEAT", sessionId: params.sessionId }).catch(() => {});
}, 15000);

document.getElementById("disconnect").addEventListener("click", async () => {
  await endSession("user-disconnect");
  window.close();
});
window.addEventListener("beforeunload", () => endSession("tab-unload"));

connect();

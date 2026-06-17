/**
 * Precision RBI — content script  [EXT-02]
 * Runs at document_start on all URLs/frames.
 *
 * HONEST SCOPE (see ARCHITECTURE §7): these are best-effort client controls and
 * BDR *telemetry*. They deter and detect; they do NOT guarantee prevention. OS
 * screenshots, screen photos, and accessibility APIs bypass page JS entirely.
 * The real isolation guarantee lives server-side in the RBI container.
 */
(() => {
  "use strict";
  if (window.__precisionRbiInjected) return;
  window.__precisionRbiInjected = true;

  const STATE = {
    policy: { blockClipboard: false, blockDownload: false, blockPrint: false, watermark: false },
    isolated: false, // set true when running inside an isolated context flag
  };

  // --- config pull from extension storage -----------------------------------
  chrome.storage.sync.get(
    { dlpBlockClipboard: false, dlpBlockDownload: false, dlpBlockPrint: false, dlpWatermark: false },
    (c) => {
      STATE.policy = {
        blockClipboard: c.dlpBlockClipboard,
        blockDownload: c.dlpBlockDownload,
        blockPrint: c.dlpBlockPrint,
        watermark: c.dlpWatermark,
      };
      if (STATE.policy.watermark) injectWatermark();
    }
  );

  // --- BDR event reporter ----------------------------------------------------
  let lastSent = {};
  function report(type, details) {
    // light client-side dedupe (max 1 of a type / 3s) to avoid flooding
    const now = Date.now();
    if (lastSent[type] && now - lastSent[type] < 3000) return;
    lastSent[type] = now;
    chrome.runtime.sendMessage({ type: "BDR_FORWARD", event: { type, url: location.href, details } }).catch(() => {});
  }

  // --- clipboard DLP [EXT-02] -----------------------------------------------
  ["copy", "cut", "paste"].forEach((evt) => {
    document.addEventListener(
      evt,
      (e) => {
        report("CLIPBOARD_ATTEMPT", { event: evt });
        if (STATE.policy.blockClipboard) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  });

  // --- print DLP -------------------------------------------------------------
  window.addEventListener("beforeprint", (e) => {
    report("PRINT_ATTEMPT", {});
    if (STATE.policy.blockPrint) { e.preventDefault(); }
  });

  // --- download DLP (anchor[download] + programmatic) -----------------------
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a[download], a[href$='.exe'], a[href$='.zip'], a[href$='.dmg']");
      if (a) {
        report("DOWNLOAD_ATTEMPT", { href: a.href });
        if (STATE.policy.blockDownload) { e.preventDefault(); e.stopImmediatePropagation(); }
      }
    },
    true
  );

  // --- screenshot deterrent (TELEMETRY, not prevention) ---------------------
  // Canvas readback fingerprinting is a known exfil/canvas-grab signal. We watch
  // it and report; we do NOT claim to block screen capture.
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      report("CANVAS_READBACK", { w: args[2], h: args[3] });
      return origGetImageData.apply(this, args);
    };
  } catch { /* sandboxed frame */ }

  // --- keystroke-hook detection (heuristic TELEMETRY) -----------------------
  // We flag suspicious global listener installs on document keydown/keypress.
  try {
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if ((type === "keydown" || type === "keypress" || type === "keyup") &&
          (this === document || this === window)) {
        const src = String(listener);
        if (/fetch\(|XMLHttpRequest|sendBeacon|btoa\(/.test(src)) {
          report("KEYSTROKE_HOOK", { type, hint: "listener references network/encode" });
        }
      }
      return origAdd.call(this, type, listener, opts);
    };
  } catch { /* ignore */ }

  // --- OAuth/token exfil detection via postMessage --------------------------
  window.addEventListener(
    "message",
    (e) => {
      try {
        const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
        if (/access_token|id_token|refresh_token|Bearer\s|client_secret/i.test(data) &&
            e.origin !== location.origin) {
          report("OAUTH_EXFIL", { toOrigin: location.origin, fromOrigin: e.origin });
        }
      } catch { /* non-serializable */ }
    },
    true
  );

  // --- malicious-extension / DOM-anomaly periodic scan ----------------------
  function domFingerprintScan() {
    // crude: flag injected nodes that look like overlay credential harvesters
    const suspicious = document.querySelectorAll(
      "iframe[src^='data:'], input[type='password']:not([name]):not([id])"
    );
    const dataUriScripts = [...document.scripts].filter((s) => (s.src || "").startsWith("data:"));
    if (suspicious.length > 2 || dataUriScripts.length > 0) {
      report("MALICIOUS_EXTENSION", { suspicious: suspicious.length, dataUriScripts: dataUriScripts.length });
    }
  }
  setInterval(domFingerprintScan, 30000);

  // --- watermark loader ------------------------------------------------------
  function injectWatermark() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/watermark.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }
})();

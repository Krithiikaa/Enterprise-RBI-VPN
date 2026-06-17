/**
 * Precision RBI — watermark overlay  [EXT-02]
 * Tiled, semi-transparent, pointer-events:none overlay. Deterrent for casual
 * screen-sharing/photos; not a capture-prevention mechanism.
 */
(() => {
  "use strict";
  if (document.getElementById("__precision-rbi-watermark")) return;

  const label = `PRECISION RBI · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  // Build a tiled SVG data URI so it scales and repeats cheaply.
  const tile = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
      <text x="0" y="100" transform="rotate(-30 160 90)"
        font-family="monospace" font-size="14" fill="rgba(127,255,212,0.10)">${label}</text>
    </svg>`);

  const o = document.createElement("div");
  o.id = "__precision-rbi-watermark";
  Object.assign(o.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    backgroundImage: `url("data:image/svg+xml,${tile}")`,
    backgroundRepeat: "repeat",
    mixBlendMode: "difference",
  });

  const mount = () => (document.body || document.documentElement).appendChild(o);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  // Re-assert if the page tries to remove it.
  new MutationObserver(() => {
    if (!document.getElementById("__precision-rbi-watermark")) mount();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

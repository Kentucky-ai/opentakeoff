// Canvas FOCUS mode (small-screen chrome collapse) — ported from the Spline
// sibling, the theme.js pattern: localStorage is the store, a window
// CustomEvent is the broadcast, the canvas collapses its own rows. Per-user,
// survives reload. Orthogonal to the sheet invert (☾) and the chrome theme —
// this trades CHROME for canvas height, nothing else.

const KEY = "ot_canvas_focus";
const EVT = "opentakeoff:canvas-focus";

export function getFocusMode() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function setFocusMode(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode — session-only */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: !!on }));
}

export function toggleFocusMode() {
  const next = !getFocusMode();
  setFocusMode(next);
  return next;
}

// Subscribe React state to focus changes (toggle here, or another surface).
// Returns the unsubscribe fn, so it can be a useEffect body directly.
export function onFocusModeChange(fn) {
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

// Small-screen breakpoint for AUTOMATIC chrome compaction — no toggle needed.
// Catches 13–14" laptop viewports (≈1440×820 in-browser, 1512×880 on a 14"
// MBP) while big displays keep the full labeled toolbar. Pure — the resize
// listener in the canvas feeds it live values.
export function isCompactViewport(w, h) {
  return w < 1500 || h < 900;
}

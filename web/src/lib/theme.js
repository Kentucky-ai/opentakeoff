// App chrome theme (light/dark). The <html data-theme> attribute is the source
// of truth — index.html sets it before first paint. This module changes it and
// keeps it in sync with the OS preference and other tabs; tokens.css does the
// actual theming. Orthogonal to the canvas ☾ invert (opentakeoff_dark), which
// is a per-sheet work-mode preference that flows into the marked-set export.

const KEY = "opentakeoff_theme";
const EVT = "opentakeoff:theme";

function apply(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", t === "dark" ? "#121c2c" : "#f4efe0");
  window.dispatchEvent(new CustomEvent(EVT, { detail: t }));
}

export function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  apply(next);
  try { localStorage.setItem(KEY, next); } catch { /* private mode — session-only */ }
  return next;
}

// Subscribe React state to any theme change (toggle, OS flip, other tab).
// Returns the unsubscribe fn, so it can be a useEffect body directly.
export function onThemeChange(fn) {
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

// Call once at startup. Non-togglers (no stored choice) follow live OS
// changes; an explicit choice made in another tab syncs here via `storage`
// (which never fires in the tab that set it, so no double-apply).
export function initTheme() {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onOsChange = (e) => {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { /* private mode */ }
    if (stored !== "light" && stored !== "dark") apply(e.matches ? "dark" : "light");
  };
  if (mq.addEventListener) mq.addEventListener("change", onOsChange);
  else mq.addListener(onOsChange);   // Safari < 14
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && (e.newValue === "light" || e.newValue === "dark")) apply(e.newValue);
  });
}

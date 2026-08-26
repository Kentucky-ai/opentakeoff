// draftOutline — the opt-in "outline area while drawing" preference. Pure
// persistence, mirroring theme.js / the persistence section of drawStyles.js
// exactly: localStorage guarded on `typeof localStorage` (NOT `typeof
// window` — the stubbed-localStorage test idiom depends on it) plus
// try/catch; event dispatch alone is guarded on `typeof window`. No canvas
// changes live here — this module only tracks and broadcasts the choice.
const KEY = "opentakeoff_draft_outline";
const EVT = "opentakeoff:draftoutline";

// Stored as the explicit strings "1"/"0" (never JS true/false, which
// localStorage would coerce to "true"/"false" anyway) — a stable on-disk
// encoding that's cheap to eyeball in devtools and cheap to validate on read.
const ON = "1";
const OFF = "0";

export function getDraftOutline() {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KEY) === ON;   // anything else (missing, "0", garbage) reads as off
  } catch { return false; }   // private mode / denied storage
}

export function setDraftOutline(on) {
  const v = !!on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, v ? ON : OFF);
  } catch { /* quota / private mode — session-only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVT, { detail: v }));
}

// Subscribe React state to any change (the setting's own toggle, other tab).
// Returns the unsubscribe fn, so it can be a useEffect body directly.
export function onDraftOutlineChange(fn) {
  if (typeof window === "undefined") return () => {};
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

// Call once at startup (main.jsx, next to initDrawStyle). A choice made in
// another tab syncs here via `storage` — key-gated and value-whitelisted, and
// `storage` never fires in the tab that set it, so no double-apply.
export function initDraftOutline() {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && (e.newValue === ON || e.newValue === OFF)) {
      window.dispatchEvent(new CustomEvent(EVT, { detail: e.newValue === ON }));
    }
  });
}

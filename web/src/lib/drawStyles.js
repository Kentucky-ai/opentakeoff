// Drawing styles — the token tables + resolver behind the canvas's draft chrome
// (draft polygon/polyline, rubber band, vertex markers, crosshair, readout
// chip, selection chrome). Two sections, deliberately split:
//   PURE       — token tables and functions that never touch globals, modeled
//                on lineStyles.js (node-testable, no DOM);
//   PERSISTENCE — the per-user preference, modeled on theme.js: localStorage +
//                a CustomEvent, guarded on `typeof localStorage` plus try/catch
//                (NOT `typeof window` — the stubbed-localStorage test idiom
//                depends on it); event dispatch alone is guarded on `window`.
// Drafting Table is today's look bit-for-bit and stays the default; its values
// are pinned as literals in test/drawStyles.test.ts. Every theme spells out
// EVERY token path explicitly — no defaulting/inheritance between themes.
import { starPath } from "./geometry.js";

// ── pure: the four themes ────────────────────────────────────────────────────
// Token schema (screen px; the renderer divides by tf.scale):
//   accent                 draft stroke (deduct red and, on ring tools, an
//                          invalidColor flip win over it)
//   draft.width/lineWidth  polygon+rect / linear+curve widths (surface un-themed)
//   lastSegWidth           bold last-segment cue, null = none
//   rubber.lockColor       45° lock recolors, never thickens (null = no recolor)
//   closePreview           ring tools' last→first ghost edge, null = none
//   invalidColor           ring-tool self-intersection flip, null = never
//   casing                 under-stroke behind draft strokes, false = none
//   chip.bg/fg/border and warn* are the chip chrome's concrete CSS strings —
//   drafting's "paper" chrome keeps the literal var(--…) strings so the chip
//   tracks the APP theme, exactly like today (the amber-warning restore
//   re-applies these same strings)
//   symbol.seed/question   symbol-sweep markers: the marquee'd seed ring
//                          (sweep.seed) and unresolved "?" verdict marks —
//                          drafting's pair is today's hardcoded TakeoffCanvas
//                          literals (#7a00e6 / #ff8c00), pinned for parity
//   dark                   sparse deep-merged overrides for the canvas ☾ invert
export const DRAW_STYLES = {
  contemporary: {
    label: "Contemporary",
    accent: "#2ec927",
    draft: { width: 2.75, lineWidth: 2.75, dash: null, fillMode: "none", tintAlpha: null },
    lastSegWidth: null,
    rubber: { width: 2.75, lockWidth: 3.5, opacity: 1, dash: null, lockColor: null },
    closePreview: { dash: [2, 5], width: 2 },
    invalidColor: "#e03131",
    vertex: { shape: "none", r: 3, lastR: 4.5, casing: false },
    casing: false,
    edgeLabels: false,
    selection: { color: "#1f3fc7", width: 4, handleShape: "square", handleFill: "hollow" },
    chip: {
      font: "sans", chrome: "panelDark", anchor: "cursor",
      bg: "#111827", fg: "#f9fafb", border: "#111827",
      warnBg: "var(--c-warning)", warnFg: "#111827", warnBorder: "var(--c-warning)",
    },
    crosshair: "hairline",
    aimMark: "square",
    aimMarkColor: "#2ec927",
    // violet marquee cue reads clean against the neon-green accent; amber
    // caution stays clear of the red invalidColor flip
    symbol: { seed: "#a855f7", question: "#f59e0b" },
    dark: {},   // intentionally empty: neon green carries on an inverted sheet
  },
  precision: {
    label: "Precision",
    accent: "#3b6ce7",
    draft: { width: 1.5, lineWidth: 1.5, dash: [6, 4], fillMode: "tint", tintAlpha: 0.08 },
    lastSegWidth: null,
    rubber: { width: 1.5, lockWidth: 2.5, opacity: 0.9, dash: [6, 4], lockColor: null },
    closePreview: null,
    invalidColor: null,
    vertex: { shape: "square", r: 3, lastR: 4, casing: false },
    casing: false,
    edgeLabels: "all",
    selection: { color: "#2563eb", width: 3, handleShape: "square", handleFill: "paper" },
    chip: {
      font: "sans", chrome: "panelCream", anchor: "cursor",
      bg: "#f7f3e8", fg: "#1f2937", border: "#c9c2ae",
      warnBg: "var(--c-warning)", warnFg: "#f7f3e8", warnBorder: "var(--c-warning)",
    },
    crosshair: "hairline",
    aimMark: "ring",
    aimMarkColor: "#111827",
    // cool violet keeps the blueprint's restrained palette; bright amber
    // (not the muted warning var) still reads as caution on the cream chip
    symbol: { seed: "#7c3aed", question: "#d97706" },
    dark: { aimMarkColor: "#e5e7eb" },   // a black ring is invisible on inverted sheets
  },
  drafting: {
    // today's look, value for value — regressing this default is the top risk,
    // so the unit test pins every one of these as a literal
    label: "Drafting Table",
    accent: "#1f3fc7",
    draft: { width: 2, lineWidth: 2.5, dash: null, fillMode: "condition", tintAlpha: null },
    lastSegWidth: 3.5,
    rubber: { width: 1.5, lockWidth: 3, opacity: 0.85, dash: null, lockColor: null },
    closePreview: null,
    invalidColor: null,
    vertex: { shape: "star", r: 3, lastR: 4.5, casing: false },
    casing: false,
    edgeLabels: false,
    selection: { color: "#1f3fc7", width: 4, handleShape: "diamond", handleFill: "paper" },
    chip: {
      font: "mono", chrome: "paper", anchor: "cursor",
      bg: "var(--paper-bright)", fg: "var(--ink)", border: "var(--ink)",
      warnBg: "var(--c-warning)", warnFg: "var(--paper-bright)", warnBorder: "var(--c-warning)",
    },
    crosshair: "hairline",
    aimMark: "star",
    aimMarkColor: "#1f3fc7",
    // today's hardcoded TakeoffCanvas literals (sweep.seed ring / "?" verdict
    // mark) — pinned verbatim, this is the parity gate, not a new choice
    symbol: { seed: "#7a00e6", question: "#ff8c00" },
    dark: {},
  },
  siteglass: {
    label: "Site Glass",
    accent: "#1f3fc7",
    draft: { width: 2, lineWidth: 2, dash: null, fillMode: "none", tintAlpha: null },
    lastSegWidth: 3,
    rubber: { width: 2, lockWidth: 2, opacity: 0.9, dash: null, lockColor: "#1f6b4a" },
    closePreview: null,
    invalidColor: null,
    vertex: { shape: "dot", r: 3, lastR: 4.5, casing: true },
    casing: { width: 4.5, color: "#fff" },
    edgeLabels: "last2",
    selection: { color: "#1f3fc7", width: 4, handleShape: "dot", handleFill: "paper" },
    chip: {
      font: "mono", chrome: "glass", anchor: "lastVertex",
      bg: "rgba(255, 255, 255, 0.72)", fg: "#0b0e14", border: "rgba(11, 14, 20, 0.3)",
      warnBg: "var(--c-warning)", warnFg: "#fff", warnBorder: "var(--c-warning)",
    },
    crosshair: "hairline",
    aimMark: "dot",
    aimMarkColor: "#1f3fc7",
    // luminous violet and bright amber stay legible over the translucent
    // glass chip's photo-backed canvas
    symbol: { seed: "#9d4edd", question: "#ff9500" },
    dark: { casing: { color: "#0b0e14" } },   // grip-casing precedent: dark flips to sheet-dark
  },
};

export const DRAW_STYLE_IDS = Object.keys(DRAW_STYLES);   // picker order
export const DEFAULT_DRAW_STYLE = "drafting";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = deepClone(v[k]); return o; }
  return v;
}
function deepMerge(base, delta) {
  const out = deepClone(base);
  for (const k of Object.keys(delta || {})) {
    out[k] = isObj(out[k]) && isObj(delta[k]) ? deepMerge(out[k], delta[k]) : deepClone(delta[k]);
  }
  return out;
}

// Resolve a style id (+ canvas ☾ dark) to a ready-to-render theme: dark deltas
// deep-merged, derived strings precomputed ONCE — the mover runs per mousemove
// and must never build rgba strings there. Always a fresh deep copy; DRAW_STYLES
// is never mutated. Unknown id → drafting.
export function resolveDrawStyle(id, dark = false) {
  const base = DRAW_STYLES[id] || DRAW_STYLES[DEFAULT_DRAW_STYLE];
  const { dark: delta, ...light } = base;
  const t = dark ? deepMerge(light, delta) : deepClone(light);
  // crosshair hairline + aim glow, mirroring today's lock alphas: base .55 →
  // lock .85; box shadows keep the white keyline and swap the accent glow
  t._hairline = rgbaFromHex(t.accent, 0.55);
  t._hairlineLock = {
    background: rgbaFromHex(t.accent, 0.85),
    boxShadow: `0 0 0 0.5px rgba(255,255,255,.6), 0 0 6px ${rgbaFromHex(t.accent, 0.5)}`,
    boxShadowBase: `0 0 0 0.5px rgba(255,255,255,.55), 0 0 4px ${rgbaFromHex(t.accent, 0.3)}`,
  };
  t._aimGlow = rgbaFromHex(t.accent, 0.6);
  return t;
}

// SVG path for a vertex/aim marker centered on (x,y) with radius r.
// "star" is the house mark (geometry.starPath); "none"/unknown → null so the
// caller can skip the element entirely.
export function markerPath(shape, x, y, r) {
  if (shape === "star") return starPath(x, y, r);
  if (shape === "dot") return `M${x - r},${y} A${r},${r} 0 1 0 ${x + r},${y} A${r},${r} 0 1 0 ${x - r},${y} Z`;
  if (shape === "square") return `M${x - r},${y - r} L${x + r},${y - r} L${x + r},${y + r} L${x - r},${y + r} Z`;
  if (shape === "diamond") return `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`;
  return null;
}

// SVG strokeDasharray for a theme dash, screen-relative (divided by the stage
// scale — the `${n/z}` convention). Returns undefined for solid (null/[]) —
// NEVER "" or []: React drops an undefined attribute, so a solid stroke gets
// no stroke-dasharray at all (same contract as lineStyles.dashArrayFor).
export function drawDashFor(dash, scale = 1) {
  if (!dash || !dash.length) return undefined;
  const s = scale || 1;
  return dash.map((n) => n / s).join(" ");
}

// "#1f3fc7", 0.55 → "rgba(31, 63, 199, 0.55)". Tolerant of malformed input
// (theme tables are code today, but tolerate hand-edited garbage): coerces to
// a mid grey rather than leaking invalid CSS; alpha clamps to [0,1], garbage → 1.
export function rgbaFromHex(hex, alpha) {
  const s = String(hex || "").trim().replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const ok = /^[0-9a-fA-F]{6}$/.test(v);
  const r = ok ? parseInt(v.slice(0, 2), 16) : 136;
  const g = ok ? parseInt(v.slice(2, 4), 16) : 136;
  const b = ok ? parseInt(v.slice(4, 6), 16) : 136;
  const n = Number(alpha);
  const a = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── persistence: the per-user preference (mirrors theme.js) ─────────────────
const KEY = "opentakeoff_draw_style";
const EVT = "opentakeoff:drawstyle";

export function getDrawStyle() {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_DRAW_STYLE;
    const v = localStorage.getItem(KEY);
    return DRAW_STYLE_IDS.includes(v) ? v : DEFAULT_DRAW_STYLE;
  } catch { return DEFAULT_DRAW_STYLE; }   // private mode / denied storage
}

export function setDrawStyle(id) {
  if (!DRAW_STYLE_IDS.includes(id)) return;   // never persist or broadcast a non-canonical id
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, id);
  } catch { /* quota / private mode — session-only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVT, { detail: id }));
}

// Subscribe React state to any style change (picker, voice, other tab).
// Returns the unsubscribe fn, so it can be a useEffect body directly.
export function onDrawStyleChange(fn) {
  if (typeof window === "undefined") return () => {};
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

// Call once at startup (main.jsx, next to initTheme). A choice made in another
// tab syncs here via `storage` — key-gated and value-whitelisted, and `storage`
// never fires in the tab that set it, so no double-apply.
export function initDrawStyle() {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && DRAW_STYLE_IDS.includes(e.newValue)) {
      window.dispatchEvent(new CustomEvent(EVT, { detail: e.newValue }));
    }
  });
}

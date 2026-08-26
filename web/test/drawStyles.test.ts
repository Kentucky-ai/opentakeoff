// drawStyles — the pure drawing-style token tables + resolver behind the canvas
// draft chrome. The contracts that bite, pinned here: Drafting Table IS today's
// look (every literal asserted AS A LITERAL in this file, never computed from
// the module — regressing the default is the top risk), drawDashFor must be
// FALSY for solid (never "" / [] — same contract as lineStyles.dashArrayFor),
// dark resolution deep-merges without mutating the source tables, and the
// persistence layer never throws (stubbed-localStorage idiom, identity.test.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DRAW_STYLES, DRAW_STYLE_IDS, DEFAULT_DRAW_STYLE, resolveDrawStyle,
  markerPath, drawDashFor, rgbaFromHex, getDrawStyle, setDrawStyle,
} from "../src/lib/drawStyles.js";
import { starPath } from "../src/lib/geometry.js";

test("DRAW_STYLES exposes the four styles in picker order, drafting the default", () => {
  assert.deepEqual(DRAW_STYLE_IDS, ["contemporary", "precision", "drafting", "siteglass"]);
  assert.equal(DEFAULT_DRAW_STYLE, "drafting");
  const styles = DRAW_STYLES as Record<string, { label: string }>;
  for (const id of DRAW_STYLE_IDS) assert.ok(styles[id].label, `${id} has a label`);
});

// ── schema completeness: every token path, every theme, right types ─────────
// No optional-path carve-outs: the module spells every path out explicitly on
// every theme (the design-doc listings elide defaults; the module must not).
type Check = (v: unknown) => boolean;
const isNum: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isStr: Check = (v) => typeof v === "string" && v.length > 0;
const isBool: Check = (v) => typeof v === "boolean";
const isHex: Check = (v) => typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
const numOrNull: Check = (v) => v === null || isNum(v);
const dashOrNull: Check = (v) => v === null || (Array.isArray(v) && v.length > 0 && v.every((n) => isNum(n)));
const oneOf = (...vals: unknown[]): Check => (v) => vals.includes(v);

const SCHEMA: Record<string, Check> = {
  "label": isStr,
  "accent": isHex,
  "draft.width": isNum,
  "draft.lineWidth": isNum,
  "draft.dash": dashOrNull,
  "draft.fillMode": oneOf("condition", "tint", "none"),
  "draft.tintAlpha": numOrNull,
  "lastSegWidth": numOrNull,
  "rubber.width": isNum,
  "rubber.lockWidth": isNum,
  "rubber.opacity": isNum,
  "rubber.dash": dashOrNull,
  "rubber.lockColor": (v) => v === null || isHex(v),
  "closePreview": (v) => v === null ||
    (!!v && isNum((v as { width: unknown }).width) && dashOrNull((v as { dash: unknown }).dash) && (v as { dash: unknown }).dash !== null),
  "invalidColor": (v) => v === null || isHex(v),
  "vertex.shape": oneOf("star", "dot", "square", "none"),
  "vertex.r": isNum,
  "vertex.lastR": isNum,
  "vertex.casing": isBool,
  "casing": (v) => v === false ||
    (!!v && isNum((v as { width: unknown }).width) && isStr((v as { color: unknown }).color)),
  "edgeLabels": oneOf(false, "all", "last2"),
  "selection.color": isHex,
  "selection.width": isNum,
  "selection.handleShape": oneOf("diamond", "square", "dot"),
  "selection.handleFill": oneOf("paper", "hollow"),
  "chip.font": oneOf("mono", "sans"),
  "chip.chrome": oneOf("paper", "glass", "panelDark", "panelCream"),
  "chip.anchor": oneOf("cursor", "lastVertex"),
  "chip.bg": isStr,
  "chip.fg": isStr,
  "chip.border": isStr,
  "chip.warnBg": isStr,
  "chip.warnFg": isStr,
  "chip.warnBorder": isStr,
  "crosshair": oneOf("hairline", "none"),
  "aimMark": oneOf("star", "square", "ring", "dot"),
  "aimMarkColor": isHex,
  "symbol.seed": isHex,
  "symbol.question": isHex,
  "dark": (v) => !!v && typeof v === "object" && !Array.isArray(v),
};

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v == null ? undefined : (v as Record<string, unknown>)[k]), o);

test("every theme spells out every token path with the right type", () => {
  for (const id of DRAW_STYLE_IDS) {
    const theme = (DRAW_STYLES as Record<string, unknown>)[id];
    for (const [path, check] of Object.entries(SCHEMA)) {
      const v = get(theme, path);
      assert.notEqual(v, undefined, `${id}.${path} must be spelled out`);
      assert.ok(check(v), `${id}.${path} has the wrong shape: ${JSON.stringify(v)}`);
    }
  }
});

// ── Drafting Table is today's look, value for value — LITERALS, never computed
test("drafting: every token pinned to today's literal", () => {
  const d = DRAW_STYLES.drafting;
  assert.equal(d.accent, "#1f3fc7");
  assert.equal(d.draft.width, 2);
  assert.equal(d.draft.lineWidth, 2.5);
  assert.equal(d.draft.dash, null);
  assert.equal(d.draft.fillMode, "condition");
  assert.equal(d.draft.tintAlpha, null);
  assert.equal(d.lastSegWidth, 3.5);
  assert.equal(d.rubber.width, 1.5);
  assert.equal(d.rubber.lockWidth, 3);
  assert.equal(d.rubber.opacity, 0.85);
  assert.equal(d.rubber.dash, null);
  assert.equal(d.rubber.lockColor, null);
  assert.equal(d.closePreview, null);
  assert.equal(d.invalidColor, null);
  assert.equal(d.vertex.shape, "star");
  assert.equal(d.vertex.r, 3);
  assert.equal(d.vertex.lastR, 4.5);
  assert.equal(d.vertex.casing, false);
  assert.equal(d.casing, false);
  assert.equal(d.edgeLabels, false);
  assert.equal(d.selection.color, "#1f3fc7");
  assert.equal(d.selection.width, 4);
  assert.equal(d.selection.handleShape, "diamond");
  assert.equal(d.selection.handleFill, "paper");
  assert.equal(d.chip.font, "mono");
  assert.equal(d.chip.chrome, "paper");
  assert.equal(d.chip.anchor, "cursor");
  // the paper chrome is the literal CSS var() strings — the chip tracks the APP
  // theme through them; resolving to hex would change app-dark users' default
  assert.equal(d.chip.bg, "var(--paper-bright)");
  assert.equal(d.chip.fg, "var(--ink)");
  assert.equal(d.chip.border, "var(--ink)");
  assert.equal(d.chip.warnBg, "var(--c-warning)");
  assert.equal(d.chip.warnFg, "var(--paper-bright)");
  assert.equal(d.chip.warnBorder, "var(--c-warning)");
  assert.equal(d.crosshair, "hairline");
  assert.equal(d.aimMark, "star");
  assert.equal(d.aimMarkColor, "#1f3fc7");
  assert.deepEqual(d.dark, {});
});

// ── resolveDrawStyle ────────────────────────────────────────────────────────
test("resolveDrawStyle: an unknown id falls back to drafting", () => {
  for (const bad of ["wobble", "", undefined, null]) {
    const t = resolveDrawStyle(bad as string, false);
    assert.equal(t.accent, "#1f3fc7");
    assert.equal(t.vertex.shape, "star");
    assert.equal(t.label, DRAW_STYLES.drafting.label);
  }
});

test("resolveDrawStyle: dark deltas deep-merge (siblings survive)", () => {
  const sg = resolveDrawStyle("siteglass", true);
  assert.equal((sg.casing as { color: string }).color, "#0b0e14", "siteglass dark casing recolors");
  assert.equal((sg.casing as { width: number }).width, 4.5, "…but keeps its width (deep, not shallow)");
  const pr = resolveDrawStyle("precision", true);
  assert.equal(pr.aimMarkColor, "#e5e7eb", "precision dark aim ring lightens");
  assert.equal(pr.accent, "#3b6ce7", "everything else untouched");
  const co = resolveDrawStyle("contemporary", true);
  assert.equal(co.accent, "#2ec927", "contemporary dark {} is intentionally empty");
});

test("resolveDrawStyle: never mutates DRAW_STYLES (light or dark)", () => {
  const sg = resolveDrawStyle("siteglass", true);
  (sg.casing as { color: string }).color = "MUTATED";
  (sg as { accent: string }).accent = "MUTATED";
  sg.rubber.width = 999;
  assert.equal((DRAW_STYLES.siteglass.casing as { color: string }).color, "#fff");
  assert.equal(DRAW_STYLES.siteglass.accent, "#1f3fc7");
  assert.equal(DRAW_STYLES.siteglass.rubber.width, 2);
  assert.equal((DRAW_STYLES.siteglass.dark as { casing: { color: string } }).casing.color, "#0b0e14");
  const dl = resolveDrawStyle("drafting", false);
  dl.vertex.r = 999;
  dl.selection.color = "MUTATED";
  assert.equal(DRAW_STYLES.drafting.vertex.r, 3);
  assert.equal(DRAW_STYLES.drafting.selection.color, "#1f3fc7");
});

test("resolveDrawStyle: derived strings precomputed on every resolved theme", () => {
  const d = resolveDrawStyle("drafting", false);
  // pinned against today's crosshair alphas: base .55 → lock .85, glow .6
  assert.equal(d._hairline, "rgba(31, 63, 199, 0.55)");
  assert.equal(d._aimGlow, "rgba(31, 63, 199, 0.6)");
  assert.equal(d._hairlineLock.background, "rgba(31, 63, 199, 0.85)");
  assert.ok(d._hairlineLock.boxShadow.includes("rgba(31, 63, 199, 0.5)"), "lock shadow carries the accent glow");
  assert.ok(d._hairlineLock.boxShadowBase.includes("rgba(31, 63, 199, 0.3)"), "base shadow carries the quiet glow");
  for (const id of DRAW_STYLE_IDS) for (const dark of [false, true]) {
    const t = resolveDrawStyle(id, dark);
    assert.ok(isStr(t._hairline), `${id} dark=${dark} _hairline`);
    assert.ok(isStr(t._aimGlow), `${id} dark=${dark} _aimGlow`);
    assert.ok(isStr(t._hairlineLock.background), `${id} dark=${dark} _hairlineLock.background`);
    assert.ok(isStr(t._hairlineLock.boxShadow), `${id} dark=${dark} _hairlineLock.boxShadow`);
    assert.ok(isStr(t._hairlineLock.boxShadowBase), `${id} dark=${dark} _hairlineLock.boxShadowBase`);
  }
});

// ── markerPath ──────────────────────────────────────────────────────────────
test("markerPath: star delegates to the house starPath, none is null", () => {
  assert.equal(markerPath("star", 10, 20, 4.5), starPath(10, 20, 4.5));
  assert.equal(markerPath("none", 10, 20, 4.5), null);
});

test("markerPath: dot / square / diamond are closed paths around the center", () => {
  const seen = new Set<string>();
  for (const shape of ["dot", "square", "diamond"]) {
    const p = markerPath(shape, 10, 20, 4) as string;
    assert.ok(isStr(p), `${shape} yields a path`);
    assert.match(p, /^M/, `${shape} starts with a moveto`);
    assert.match(p, /Z\s*$/, `${shape} closes`);
    seen.add(p);
  }
  assert.equal(seen.size, 3, "the three shapes are distinct paths");
  // square pinned: corners at center ± r
  assert.equal(markerPath("square", 0, 0, 2), "M-2,-2 L2,-2 L2,2 L-2,2 Z");
  // diamond pinned: points on the axes at ± r
  assert.equal(markerPath("diamond", 0, 0, 3), "M0,-3 L3,0 L0,3 L-3,0 Z");
});

// ── drawDashFor ─────────────────────────────────────────────────────────────
test("drawDashFor: divides the pattern by the stage scale (screen-relative)", () => {
  assert.equal(drawDashFor([6, 4], 1), "6 4");
  assert.equal(drawDashFor([6, 4], 2), "3 2");
  assert.equal(drawDashFor([2, 5], 4), "0.5 1.25");
  assert.equal(drawDashFor([6, 4], 0), "6 4", "a zero scale falls back to 1, never divides by 0");
});

test("drawDashFor: solid is FALSY — undefined, never '' or []", () => {
  for (const solid of [null, [], undefined]) {
    const v = drawDashFor(solid as number[] | null, 2);
    assert.equal(v, undefined, `dash for ${JSON.stringify(solid)} is undefined`);
    assert.notEqual(v, "");            // React would still emit "" as an attribute
    assert.notDeepEqual(v, []);
  }
});

// ── rgbaFromHex ─────────────────────────────────────────────────────────────
test("rgbaFromHex: pins the output format", () => {
  assert.equal(rgbaFromHex("#1f3fc7", 0.55), "rgba(31, 63, 199, 0.55)");
  assert.equal(rgbaFromHex("#2ec927", 1), "rgba(46, 201, 39, 1)");
  assert.equal(rgbaFromHex("#fff", 0.5), "rgba(255, 255, 255, 0.5)", "shorthand hex expands");
});

test("rgbaFromHex: malformed input never throws — a safe rgba() always comes back", () => {
  const shape = /^rgba\(\d+, \d+, \d+, [\d.]+\)$/;
  for (const bad of ["garbage", "#12", "#xyzxyz", "", undefined, null]) {
    const out = rgbaFromHex(bad as string, 0.5);
    assert.match(out, shape, `rgbaFromHex(${String(bad)}) is a valid rgba()`);
  }
  assert.match(rgbaFromHex("#1f3fc7", NaN as unknown as number), shape, "garbage alpha tolerated");
});

// ── persistence (stubbed globalThis.localStorage — identity.test.ts idiom) ──
function stubStore() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}
const unstub = () => { delete (globalThis as { localStorage?: unknown }).localStorage; };

test("getDrawStyle: a garbage stored value falls back to drafting; a real one reads back", () => {
  const store = stubStore();
  try {
    store.set("opentakeoff_draw_style", "neon-vaporwave");
    assert.equal(getDrawStyle(), "drafting");
    store.set("opentakeoff_draw_style", "precision");
    assert.equal(getDrawStyle(), "precision");
  } finally { unstub(); }
});

test("setDrawStyle: round-trips through the stubbed store", () => {
  const store = stubStore();
  try {
    setDrawStyle("contemporary");
    assert.equal(store.get("opentakeoff_draw_style"), "contemporary");
    assert.equal(getDrawStyle(), "contemporary");
  } finally { unstub(); }
});

test("persistence never throws: quota setItem, throwing getItem, no localStorage at all", () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {},
  };
  try {
    assert.doesNotThrow(() => setDrawStyle("siteglass"));
    assert.equal(getDrawStyle(), "drafting", "a throwing getItem reads as the default");
  } finally { unstub(); }
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  assert.equal(getDrawStyle(), "drafting");
  assert.doesNotThrow(() => setDrawStyle("precision"));
});

// ── upstream parity: drafting must equal today's hardcoded canvas values ────
// This is the regression gate for the port. resolveDrawStyle("drafting") is
// what the renderer will actually consume — not the raw DRAW_STYLES.drafting
// table — so the gate asserts against the RESOLVED theme. If any of these
// fails, the ported value has drifted from what's live in TakeoffCanvas today;
// that's a real divergence to adjudicate, not a value to quietly change.
describe("drafting parity with upstream", () => {
  test("resolveDrawStyle('drafting') matches today's live canvas values exactly", () => {
    const draft = resolveDrawStyle("drafting");
    assert.equal(draft.accent, "#1f3fc7");
    assert.equal(draft.draft.width, 2);
    assert.equal(draft.draft.lineWidth, 2.5);
    assert.equal(draft.draft.dash, null);
    assert.equal(draft.lastSegWidth, 3.5);
    assert.equal(draft.rubber.width, 1.5);
    assert.equal(draft.rubber.lockWidth, 3);
    assert.equal(draft.vertex.shape, "star");
    assert.equal(draft.vertex.r, 3);
    assert.equal(draft.vertex.lastR, 4.5);
    assert.equal(draft.vertex.casing, false);
    assert.equal(draft.casing, false);
    assert.equal(draft.closePreview, null);
    assert.equal(draft.edgeLabels, false);
    assert.equal(draft.selection.width, 4);
    assert.equal(draft.selection.handleShape, "diamond");
    assert.equal(draft.aimMark, "star");
    assert.equal(draft.aimMarkColor, "#1f3fc7");
    assert.equal(draft.crosshair, "hairline");
    // symbol tokens are new (not in the pre-port upstream module) but their
    // values ARE today's hardcoded TakeoffCanvas literals — parity, not a
    // fresh choice: sweep.seed circles use #7a00e6, "?" verdict marks use #ff8c00
    assert.equal(draft.symbol.seed, "#7a00e6");
    assert.equal(draft.symbol.question, "#ff8c00");
  });
});

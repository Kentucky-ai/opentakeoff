// Report theme import: map a Claude Design (DTCG-flavored) tokens.json onto the
// small internal theme model the report/marked-set renderers consume, then
// project that model onto the app's real CSS custom-property names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseThemeFile, themeToCssVars, activeThemeVars, activeTheme } from "../src/lib/reportTheme.js";

const claude = JSON.parse(
  readFileSync(new URL("./fixtures/claude-design.tokens.json", import.meta.url), "utf8"),
);

test("imports neutral ink/paper and the web font family from a Claude Design tokens file", () => {
  const { theme } = parseThemeFile(claude);
  assert.equal(theme.color.ink, "#2E333B");
  assert.equal(theme.color.paper, "#FBFBF8");
  assert.equal(theme.font.display, "Inter Tight");
});

test("captures the theme name for display", () => {
  assert.equal(parseThemeFile(claude).theme.name, "345 / Fin — Drafting-Table Document System");
  assert.equal(parseThemeFile({}).theme.name, undefined);
});

test("normalizes hex colors to canonical #RRGGBB (expands shorthand, adds #, upper-cases)", () => {
  const { theme } = parseThemeFile({ color: { neutral: { ink: { value: "#abc" }, paper: { value: "fbfbf8" } } } });
  assert.equal(theme.color.ink, "#AABBCC");
  assert.equal(theme.color.paper, "#FBFBF8");
});

test("imports all three web font roles", () => {
  const { theme } = parseThemeFile(claude);
  assert.equal(theme.font.display, "Inter Tight");
  assert.equal(theme.font.body, "Inter Tight");
  assert.equal(theme.font.mono, "Inter Tight");
});

test("maps accent-* groups to accent/positive/warning by color name; first match wins", () => {
  const { theme } = parseThemeFile(claude);
  assert.equal(theme.color.accent, "#125792");    // accent-345.brand-blue
  assert.equal(theme.color.positive, "#288234");  // accent-345.brand-green (before fin-green)
  assert.equal(theme.color.warning, "#CF6802");   // accent-fin.fin-orange
  assert.equal(theme.color.danger, undefined);    // no red in this palette → renderer keeps its default
});

test("themeToCssVars maps roles onto the app's real custom-property names", () => {
  const { theme } = parseThemeFile(claude);
  const vars = themeToCssVars(theme);
  assert.equal(vars["--ink"], "#2E333B");
  assert.equal(vars["--cobalt"], "#125792");
  assert.equal(vars["--paper-bright"], "#FBFBF8");
  assert.equal(vars["--c-positive"], "#288234");
  assert.equal(vars["--c-warning"], "#CF6802");
  assert.equal(vars["--f-display"], "Inter Tight");
});

test("maps the neutral paper scale onto bright/cream/shadow; a lone paper also seeds cream", () => {
  const vars = themeToCssVars(parseThemeFile(claude).theme);
  assert.equal(vars["--paper-bright"], "#FBFBF8");  // neutral.paper
  assert.equal(vars["--paper-cream"], "#EBE5D6");   // neutral.paper-2 (report backdrop + totals band)
  assert.equal(vars["--paper-shadow"], "#DCD5C5");  // neutral.paper-3
  // a theme carrying only `paper` seeds --paper-cream too, so the backdrop and
  // fills don't fall back to the unthemed default while the tables recolor
  const only = themeToCssVars(parseThemeFile({ color: { neutral: { paper: { value: "#F0F0F0" } } } }).theme);
  assert.equal(only["--paper-bright"], "#F0F0F0");
  assert.equal(only["--paper-cream"], "#F0F0F0");
});

test("themeToCssVars omits vars for absent roles (partial theme keeps defaults)", () => {
  const vars = themeToCssVars({ color: { ink: "#111111" }, font: {} });
  assert.equal(vars["--ink"], "#111111");
  assert.ok(!("--cobalt" in vars));
  assert.ok(!("--c-danger" in vars));
  assert.ok(!("--f-display" in vars));
});

test("classifier ignores a 'blueprint' token even when it precedes the brand blue", () => {
  // /blue/ naively matches "blueprint"; with first-wins, a blueprint-before-blue
  // ordering would silently steal the accent role. The accent must stay the real blue.
  const { theme } = parseThemeFile({
    color: { "accent-x": { blueprint: { value: "#3E6F94" }, "brand-blue": { value: "#125792" } } },
  });
  assert.equal(theme.color.accent, "#125792");
});

test("drops an invalid color with a warning instead of emitting garbage", () => {
  const { theme, warnings } = parseThemeFile({ color: { neutral: { ink: { value: "rgb(1,2,3)" }, paper: { value: "#FBFBF8" } } } });
  assert.equal(theme.color.ink, undefined);
  assert.equal(theme.color.paper, "#FBFBF8");
  assert.ok(warnings.some((w) => /ink/.test(w)), `expected a warning mentioning ink, got ${JSON.stringify(warnings)}`);
});

test("never throws on malformed/untrusted input (the file is user-supplied)", () => {
  for (const bad of [null, undefined, 42, "str", ["a"], {}, { color: 5 }, { color: { neutral: null } }]) {
    const { theme, warnings } = parseThemeFile(bad as any);
    assert.deepEqual(theme, { color: {}, font: {} });
    assert.deepEqual(warnings, []);
  }
});

test("activeThemeVars reads the stored file, adapts it, and gives fonts a fallback stack", () => {
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  (globalThis as any).localStorage = {
    _s: { opentakeoff_report_theme: JSON.stringify(claude) } as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  try {
    const vars = activeThemeVars();
    assert.equal(vars["--ink"], "#2E333B");
    assert.equal(vars["--cobalt"], "#125792");
    assert.equal(vars["--f-display"], '"Inter Tight", system-ui, sans-serif');
    // mono keeps a monospace fallback so figures stay column-aligned if the
    // imported family isn't available
    assert.equal(vars["--f-mono"], '"Inter Tight", ui-monospace, monospace');
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("activeThemeVars returns {} (defaults stand) when nothing is stored", () => {
  (globalThis as any).localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  try {
    assert.deepEqual(activeThemeVars(), {});
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("activeTheme exposes vars + name + warnings for the UI, and is empty when none", () => {
  (globalThis as any).localStorage = {
    _s: { opentakeoff_report_theme: JSON.stringify(claude) } as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  try {
    const t = activeTheme();
    assert.equal(t.name, "345 / Fin — Drafting-Table Document System");
    assert.equal(t.vars["--cobalt"], "#125792");
    assert.deepEqual(t.warnings, []);
    (globalThis as any).localStorage.removeItem("opentakeoff_report_theme");
    assert.deepEqual(activeTheme(), { vars: {}, name: null, warnings: [] });
  } finally {
    delete (globalThis as any).localStorage;
  }
});

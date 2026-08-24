// Global unit-system preference — behavioral contract and label parity.
// Verifies that the approved label strings appear in both locales, that
// TakeoffCanvas does NOT persist or hydrate per-project units overrides,
// and that the provider reads from the canonical localStorage key.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readUnitSystem, writeUnitSystem, normalizeUnitSystem, UNIT_SYSTEM_KEY, migrateLegacyUnit, LEGACY_UNIT_KEY } from "../src/lib/unitPreference.js";

const here = path.resolve(import.meta.dirname, "..");

// ── locale label parity ──────────────────────────────────────────────────────

const en = JSON.parse(fs.readFileSync(path.join(here, "public/locales/en/panels.json"), "utf8"));
const ptbr = JSON.parse(fs.readFileSync(path.join(here, "public/locales/pt-br/panels.json"), "utf8"));

test("units.imperial_option is the exact approved string in English", () => {
  assert.equal(en["units.imperial_option"], "Imperial \u2014 SF, LF, ft, in");
});

test("units.metric_option is the exact approved string in English", () => {
  assert.equal(en["units.metric_option"], "SI/M\u00E9trico \u2014 m\u00B2, m, m, mm");
});

test("units.imperial_option is the exact approved string in pt-BR", () => {
  assert.equal(ptbr["units.imperial_option"], "Imperial \u2014 SF, LF, ft, in");
});

test("units.metric_option is the exact approved string in pt-BR", () => {
  assert.equal(ptbr["units.metric_option"], "SI/M\u00E9trico \u2014 m\u00B2, m, m, mm");
});

test("both locales have all required units.* keys", () => {
  const required = [
    "units.title",
    "units.description",
    "units.legend",
    "units.imperial_option",
    "units.metric_option",
    "units.note",
    "units.close",
  ];
  for (const key of required) {
    assert.ok(en[key], `English missing key: ${key}`);
    assert.ok(ptbr[key], `pt-BR missing key: ${key}`);
  }
});

// ── scale tooltip hint keys (canvas.json) ────────────────────────────────────

const enCanvas = JSON.parse(fs.readFileSync(path.join(here, "public/locales/en/canvas.json"), "utf8"));
const ptbrCanvas = JSON.parse(fs.readFileSync(path.join(here, "public/locales/pt-br/canvas.json"), "utf8"));

test("scale.metric_hint exists in English canvas locale", () => {
  assert.ok(enCanvas["scale.metric_hint"], "English canvas.json missing scale.metric_hint");
});

test("scale.imperial_hint exists in English canvas locale", () => {
  assert.ok(enCanvas["scale.imperial_hint"], "English canvas.json missing scale.imperial_hint");
});

test("scale.metric_hint exists in pt-BR canvas locale", () => {
  assert.ok(ptbrCanvas["scale.metric_hint"], "pt-BR canvas.json missing scale.metric_hint");
});

test("scale.imperial_hint exists in pt-BR canvas locale", () => {
  assert.ok(ptbrCanvas["scale.imperial_hint"], "pt-BR canvas.json missing scale.imperial_hint");
});

// ── TakeoffCanvas: no per-project units in buildPayload or hydrate ───────────

const canvas = fs.readFileSync(path.join(here, "src/pages/TakeoffCanvas.jsx"), "utf8");

test("buildPayload does NOT include per-project units in the return object", () => {
  // The old pattern was: ...(units === "metric" ? { units } : {})
  assert.ok(
    !/\{\s*units\s*\}/.test(canvas) || /NOTE.*per-project.*units.*removed/.test(canvas),
    "buildPayload must not include per-project units in its return object"
  );
});

test("hydrate does NOT apply per-project units from the payload", () => {
  // The old pattern was: if (a.units === "metric" || a.units === "imperial") setUnits(a.units);
  assert.ok(
    !/a\.units\s*===/.test(canvas),
    "hydrate must not read a.units to override the global unit system"
  );
});

test("canvas reads units from UnitSystemProvider, not local localStorage", () => {
  // The old pattern was: localStorage.getItem("opentakeoff_units")
  assert.ok(
    !/opentakeoff_units/.test(canvas),
    "TakeoffCanvas must not read/write the legacy opentakeoff_units localStorage key"
  );
  // Must use the provider hook
  assert.ok(
    /useUnitSystem/.test(canvas),
    "TakeoffCanvas must import and use useUnitSystem from the provider"
  );
});

test("autosave effect does NOT include units in its dependency array", () => {
  // The autosave effect's dependency array should not contain 'units' —
  // changing display units must not trigger a project save/push.
  // Find the autosave useEffect — look for the saveAnnotations/saving pattern
  const autosaveMatch = canvas.match(/useEffect\(\(\) =>\s*\{[\s\S]*?setSaveState\("saving"\)[\s\S]*?\},\s*\[([^\]]+)\]\)/);
  assert.ok(autosaveMatch, "Could not locate the autosave useEffect dependency array");
  const deps = autosaveMatch[1];
  assert.ok(
    !/\bunits\b/.test(deps),
    "autosave useEffect dependency array must not include 'units'"
  );
});

// ── UnitSystemProvider wiring ────────────────────────────────────────────────

test("UnitSystemProvider uses readUnitSystem/writeUnitSystem from unitPreference.js", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  assert.ok(
    /import.*readUnitSystem.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import readUnitSystem from unitPreference.js"
  );
  assert.ok(
    /import.*writeUnitSystem.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import writeUnitSystem from unitPreference.js"
  );
});

test("UnitSystemProvider calls migrateLegacyUnit on mount", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  assert.ok(
    /import.*migrateLegacyUnit.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import migrateLegacyUnit from unitPreference.js"
  );
  assert.ok(
    /migrateLegacyUnit\(\)/.test(provider),
    "UnitSystemProvider must call migrateLegacyUnit() on mount"
  );
});

test("main.jsx mounts UnitSystemProvider above both route branches", () => {
  const main = fs.readFileSync(path.join(here, "src/main.jsx"), "utf8");
  assert.ok(
    /import.*UnitSystemProvider/.test(main),
    "main.jsx must import UnitSystemProvider"
  );
  // The provider should wrap both routes — appear before <Routes> and after <GoogleAuthProvider>
  const providerIdx = main.indexOf("<UnitSystemProvider>");
  const routesIdx = main.indexOf("<Routes>");
  const authIdx = main.indexOf("<GoogleAuthProvider>");
  assert.ok(providerIdx > 0, "UnitSystemProvider must be rendered in main.jsx");
  assert.ok(authIdx < providerIdx, "UnitSystemProvider must be inside GoogleAuthProvider");
  assert.ok(providerIdx < routesIdx, "UnitSystemProvider must wrap the Routes");
});

// ── UnitSettings accessibility attributes ────────────────────────────────────

test("UnitSettings has role='dialog' and aria-modal='true'", () => {
  const settings = fs.readFileSync(path.join(here, "src/components/UnitSettings.jsx"), "utf8");
  assert.ok(/role="dialog"/.test(settings), "UnitSettings must have role=\"dialog\"");
  assert.ok(/aria-modal="true"/.test(settings), "UnitSettings must have aria-modal=\"true\"");
});

test("UnitSettings has aria-labelledby and aria-describedby", () => {
  const settings = fs.readFileSync(path.join(here, "src/components/UnitSettings.jsx"), "utf8");
  assert.ok(/aria-labelledby/.test(settings), "UnitSettings must have aria-labelledby");
  assert.ok(/aria-describedby/.test(settings), "UnitSettings must have aria-describedby");
});

test("UnitSettings handles Escape key to close", () => {
  const settings = fs.readFileSync(path.join(here, "src/components/UnitSettings.jsx"), "utf8");
  assert.ok(/Escape/.test(settings), "UnitSettings must handle Escape key");
});

test("UnitSettings restores focus to triggerRef on unmount", () => {
  const settings = fs.readFileSync(path.join(here, "src/components/UnitSettings.jsx"), "utf8");
  assert.ok(/triggerRef/.test(settings), "UnitSettings must accept triggerRef prop");
  assert.ok(/triggerRef.*current.*focus/.test(settings), "UnitSettings must restore focus to triggerRef on unmount");
});

// ── MCP payload compatibility ────────────────────────────────────────────────

test("MCP exportPayload still includes units field for compatibility", () => {
  const session = fs.readFileSync(path.join(here, "../mcp/src/session.ts"), "utf8");
  // The MCP export must keep units: "imperial" as compatibility metadata
  assert.ok(
    /units:\s*"imperial"/.test(session),
    "MCP session.ts exportPayload must keep units: 'imperial' for compatibility"
  );
});

test("MCP exportTakeoffOutput schema includes units field", () => {
  const outputs = fs.readFileSync(path.join(here, "../mcp/src/outputs.ts"), "utf8");
  assert.ok(
    /units:\s*z\.string\(\)/.test(outputs),
    "MCP outputs.ts exportTakeoffOutput must include units: z.string() for compatibility"
  );
});

// ── normalizeUnitSystem contract ─────────────────────────────────────────────

test("normalizeUnitSystem: canonical values pass through", () => {
  assert.equal(normalizeUnitSystem("imperial"), "imperial");
  assert.equal(normalizeUnitSystem("metric"), "metric");
});

test("normalizeUnitSystem: all invalid values collapse to imperial", () => {
  for (const v of ["METRIC", "Metric", "", null, undefined, 42, "si", "SI/Métrico", "Imperial — SF, LF, ft, in"]) {
    assert.equal(normalizeUnitSystem(v), "imperial", `expected imperial for ${JSON.stringify(v)}`);
  }
});

// ── readUnitSystem / writeUnitSystem round-trip ──────────────────────────────

test("readUnitSystem reads from a mock storage object", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.has(k) ? map.get(k)! : null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  assert.equal(readUnitSystem(store), "metric");
  store.setItem(UNIT_SYSTEM_KEY, "imperial");
  assert.equal(readUnitSystem(store), "imperial");
});

test("writeUnitSystem persists and returns normalised value", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.has(k) ? map.get(k)! : null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
  assert.equal(writeUnitSystem("metric", store), "metric");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric");
  assert.equal(writeUnitSystem("si", store), "imperial");
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "imperial");
});

test("writeUnitSystem does not throw on storage errors", () => {
  const brokenStore = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
  };
  assert.doesNotThrow(() => writeUnitSystem("metric", brokenStore));
  assert.equal(writeUnitSystem("metric", brokenStore), "metric");
});

test("readUnitSystem returns imperial when storage throws", () => {
  const brokenStore = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => {},
  };
  assert.equal(readUnitSystem(brokenStore), "imperial");
});

// ── legacy migration behavioral tests ────────────────────────────────────────

test("migrateLegacyUnit promotes legacy metric to canonical key", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.has(k) ? map.get(k)! : null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
  store.setItem(LEGACY_UNIT_KEY, "metric");
  migrateLegacyUnit(store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric", "canonical key should be set");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should be removed");
});

test("migrateLegacyUnit does not overwrite valid canonical value", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.has(k) ? map.get(k)! : null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
  store.setItem(UNIT_SYSTEM_KEY, "metric");
  store.setItem(LEGACY_UNIT_KEY, "imperial");
  migrateLegacyUnit(store);
  assert.equal(store.getItem(UNIT_SYSTEM_KEY), "metric", "canonical must not be overwritten");
  assert.equal(store.getItem(LEGACY_UNIT_KEY), null, "legacy key should be cleaned up");
});

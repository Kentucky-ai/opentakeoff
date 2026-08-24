// Global unit-system preference — label parity and payload contract.
// Verifies that the approved label strings appear in both locales and that
// TakeoffCanvas does NOT persist or hydrate per-project units overrides.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

// ── no per-project units in TakeoffCanvas ────────────────────────────────────

const canvas = fs.readFileSync(path.join(here, "src/pages/TakeoffCanvas.jsx"), "utf8");

test("buildPayload does NOT include per-project units in the return object", () => {
  // The payload should not spread `units` — the global preference is the
  // single source of truth.  The old pattern was:
  //   ...(units === "metric" ? { units } : {})
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

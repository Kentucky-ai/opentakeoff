// Global unit-system preference — behavioral contract and label parity.
// Verifies that the approved label strings appear in both locales, that
// TakeoffCanvas does NOT persist or hydrate per-project units overrides,
// and that the provider reads from the canonical localStorage key.
//
// buildPayload/hydrate tests extract the actual source and parse it to
// verify structural absence of `units` — they fail if units is added
// as a key, regardless of nearby comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readUnitSystem, writeUnitSystem, normalizeUnitSystem, UNIT_SYSTEM_KEY, migrateLegacyUnit, LEGACY_UNIT_KEY, resolveAfterLanguageChange } from "../src/lib/unitPreference.js";

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

/**
 * Extract the buildPayload return-object body from TakeoffCanvas source.
 * Returns the text of the object literal returned by buildPayload().
 */
function extractBuildPayloadReturn(): string {
  // Find the buildPayload function and its return statement.
  // The return is a single-line `return { ... };` inside `const buildPayload = () => {`.
  const marker = "const buildPayload = () => {";
  const start = canvas.indexOf(marker);
  assert.ok(start >= 0, "buildPayload function not found in TakeoffCanvas");

  // Find the return statement after the marker
  const bodyStart = start + marker.length;
  const returnIdx = canvas.indexOf("return {", bodyStart);
  assert.ok(returnIdx >= 0, "buildPayload must contain a return statement with an object");

  // Find the matching closing `};` — walk braces counting nesting
  let braceCount = 0;
  let i = returnIdx + "return ".length;
  // Skip the opening brace of the returned object
  while (i < canvas.length && canvas[i] !== "{") i++;
  const objStart = i;
  for (; i < canvas.length; i++) {
    if (canvas[i] === "{") braceCount++;
    if (canvas[i] === "}") braceCount--;
    if (braceCount === 0) break;
  }
  assert.ok(braceCount === 0, "Unbalanced braces in buildPayload return object");
  return canvas.slice(objStart, i + 1);
}

/**
 * Extract top-level property keys from a JavaScript object literal string.
 * Handles shorthand, computed, and spread properties. Returns only the
 * static property names (not spread expressions).
 */
function topLevelKeys(objLiteral: string): string[] {
  // Strip the outer braces
  const inner = objLiteral.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "[" || ch === "(") { depth++; current += ch; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) {
      // End of a property — extract key
      const m = current.trim().match(/^(\w+)\s*:/);
      if (m) keys.push(m[1]);
      current = "";
      continue;
    }
    current += ch;
  }
  // Last property
  const m = current.trim().match(/^(\w+)\s*:/);
  if (m) keys.push(m[1]);
  return keys;
}

test("buildPayload does NOT include per-project units in the return object", () => {
  const returnObj = extractBuildPayloadReturn();
  const keys = topLevelKeys(returnObj);
  assert.ok(
    !keys.includes("units"),
    `buildPayload return object must not have 'units' as a top-level key; found keys: [${keys.join(", ")}]`
  );
});

test("hydrate does NOT apply per-project units from the payload", () => {
  // The old pattern was: if (a.units === "metric" || a.units === "imperial") setUnits(a.units);
  // This pattern MUST NOT appear in the file — it would mean hydrate reads units from the payload.
  assert.ok(
    !/a\.units\s*===/.test(canvas),
    "hydrate must not read a.units to override the global unit system (found 'a.units ===' in TakeoffCanvas)"
  );
});

test("canvas reads units from UnitSystemProvider, not local localStorage", () => {
  // Must NOT use the legacy localStorage key directly
  assert.ok(
    !/localStorage.*opentakeoff_units|opentakeoff_units.*localStorage/.test(canvas),
    "TakeoffCanvas must not read/write the legacy opentakeoff_units via localStorage"
  );
  // Must use the provider hook
  assert.ok(
    /useUnitSystem/.test(canvas),
    "TakeoffCanvas must import and use useUnitSystem from the provider"
  );
});

test("dimension drafts cancel when the global unit system changes", () => {
  const panel = fs.readFileSync(path.join(here, "src/components/TakeoffsPanel.jsx"), "utf8");
  const canvas = fs.readFileSync(path.join(here, "src/pages/TakeoffCanvas.jsx"), "utf8");
  assert.match(panel, /useEffect\(\(\) => \{ setDraft\(null\); \}, \[units\]\)/,
    "condition dimension drafts must be cancelled on a unit switch");
  assert.match(canvas, /useEffect\(\(\) => \{ setShapeHDraft\(null\); \}, \[selectedId, units\]\)/,
    "selected-wall height drafts must be cancelled on a unit switch");
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

test("UnitSystemProvider runs migration in a layout effect with retryable ref guard", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Must import migrateLegacyUnit
  assert.ok(
    /import.*migrateLegacyUnit.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import migrateLegacyUnit from unitPreference.js"
  );
  // Must NOT have a module-level guard (let _migrated = false) — migration
  // must not be permanently skipped if storage is unavailable or a render is
  // abandoned.  A per-instance ref guard inside the component is correct.
  const providerExportIdx = provider.indexOf("export function UnitSystemProvider");
  assert.ok(providerExportIdx > 0, "UnitSystemProvider must be an exported function");
  const preamble = provider.slice(0, providerExportIdx);
  assert.ok(
    !/let\s+_\w+\s*=\s*false/.test(preamble),
    "UnitSystemProvider must NOT use a module-level guard — use a per-instance ref instead"
  );
  // Must use useLayoutEffect (or useEffect) for migration, not render-body code
  const body = provider.slice(providerExportIdx);
  assert.ok(
    /useLayoutEffect|useEffect/.test(body),
    "UnitSystemProvider must run migration in a layout effect / effect, not during render"
  );
  // Must call migrateLegacyUnit inside the effect and check the return value
  // (true = done, false = storage failure → should retry)
  assert.ok(
    /migrateLegacyUnit\(\)/.test(body),
    "UnitSystemProvider must call migrateLegacyUnit() inside the effect"
  );
  // Must conditionally set the migrated ref based on the return value
  assert.ok(
    /migratedRef\.current\s*=\s*true/.test(body),
    "UnitSystemProvider must set migratedRef.current = true only after successful migration"
  );
  // Must have a ref guard (useRef) to ensure one-time execution per mount
  assert.ok(
    /useRef/.test(body),
    "UnitSystemProvider must use a ref guard to run migration at most once per mount"
  );
  // Must have a retry mechanism — either a retryCount state or a bounded loop
  assert.ok(
    /retry|MAX_MIGRATION_RETRIES|setRetry/.test(body),
    "UnitSystemProvider must implement a bounded retry mechanism for failed migrations"
  );
});

test("UnitSystemProvider setter updates ref synchronously for two functional updates", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // The setter must write to unitSystemRef.current BEFORE or together with
  // setUnitSystemState, so two sequential functional updates both observe
  // the latest value.  Find the setUnitSystem callback body and verify the
  // ref assignment precedes or is adjacent to the setState call.
  const setterMatch = provider.match(
    /const\s+setUnitSystem\s*=\s*useCallback\(\s*\(valueOrFn\)\s*=>\s*\{([\s\S]*?)\},\s*\[\]\s*\)/
  );
  assert.ok(setterMatch, "UnitSystemProvider must define setUnitSystem as useCallback([], [])");
  const setterBody = setterMatch[1];
  // Must read from unitSystemRef.current in the functional updater
  assert.ok(
    /unitSystemRef\.current/.test(setterBody),
    "setUnitSystem must read unitSystemRef.current in the functional updater"
  );
  // Must assign to unitSystemRef.current (the sync update)
  assert.ok(
    /unitSystemRef\.current\s*=/.test(setterBody),
    "setUnitSystem must synchronously update unitSystemRef.current"
  );
  // Must call writeUnitSystem (storage write outside updater)
  assert.ok(
    /writeUnitSystem/.test(setterBody),
    "setUnitSystem must call writeUnitSystem outside the state updater"
  );
  // The ref assignment must appear before or adjacent to setUnitSystemState
  const refAssignIdx = setterBody.indexOf("unitSystemRef.current =");
  const setStateIdx = setterBody.indexOf("setUnitSystemState");
  assert.ok(refAssignIdx >= 0 && setStateIdx >= 0, "setter body must contain both ref assignment and setState");
  // They should be close together (within ~5 lines) — the ref update is
  // part of the same synchronous flow as the setState call
  const linesBetween = setterBody.slice(refAssignIdx, setStateIdx).split("\n").length;
  assert.ok(
    linesBetween <= 6,
    `unitSystemRef.current assignment and setUnitSystemState should be adjacent (${linesBetween} lines apart)`
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

// ── language-aware default wiring ──────────────────────────────────────────

test("UnitSystemProvider imports i18n and passes i18n.language to readUnitSystem", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Must import i18n
  assert.ok(
    /import.*i18n/.test(provider),
    "UnitSystemProvider must import i18n for language-aware unit default"
  );
  // Initial useState must call readUnitSystem with { lng: i18n.language }
  assert.ok(
    /readUnitSystem\(.*\{.*lng:.*i18n\.language\s*\}/.test(provider),
    "UnitSystemProvider useState must pass { lng: i18n.language } to readUnitSystem"
  );
  // Migration re-read must also pass { lng: i18n.language }
  assert.ok(
    /readUnitSystem\([^)]*\{[^}]*lng:.*i18n\.language[^}]*\}\)/.test(provider),
    "UnitSystemProvider migration re-read must pass { lng: i18n.language } to readUnitSystem"
  );
});

test("unitPreference.js exports languageDefault helper", () => {
  const src = fs.readFileSync(path.join(here, "src/lib/unitPreference.js"), "utf8");
  assert.ok(
    /export function languageDefault/.test(src),
    "unitPreference.js must export languageDefault(lng)"
  );
});

test("readUnitSystem uses languageDefault for fallback when no valid preference is stored", () => {
  const src = fs.readFileSync(path.join(here, "src/lib/unitPreference.js"), "utf8");
  // readUnitSystem must call languageDefault as fallback, not return DEFAULT_UNIT_SYSTEM directly
  assert.ok(
    /languageDefault/.test(src) && /const fallback = languageDefault\(lng\)/.test(src),
    "readUnitSystem must derive its fallback from languageDefault(lng)"
  );
});

test("unitPreference.js exports hasExplicitPreference", () => {
  const src = fs.readFileSync(path.join(here, "src/lib/unitPreference.js"), "utf8");
  assert.ok(
    /export function hasExplicitPreference/.test(src),
    "unitPreference.js must export hasExplicitPreference(storage)"
  );
});

// ── languageChanged subscription wiring ─────────────────────────────────────

test("UnitSystemProvider imports useEffect and hasExplicitPreference", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  assert.ok(
    /useEffect/.test(provider),
    "UnitSystemProvider must import useEffect for the languageChanged subscription"
  );
  assert.ok(
    /import.*hasExplicitPreference.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import hasExplicitPreference from unitPreference.js"
  );
});

test("UnitSystemProvider subscribes to i18n.on('languageChanged') with cleanup", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Must register the handler
  assert.ok(
    /i18n\.on\(\s*"languageChanged"\s*,\s*\w+\s*\)/.test(provider),
    "UnitSystemProvider must subscribe to i18n.on('languageChanged', handler)"
  );
  // Must clean up on unmount
  assert.ok(
    /i18n\.off\(\s*"languageChanged"\s*,\s*\w+\s*\)/.test(provider),
    "UnitSystemProvider must call i18n.off('languageChanged', handler) in the cleanup"
  );
});

test("languageChanged handler calls hasExplicitPreference and re-resolves with readUnitSystem", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Must call resolveAfterLanguageChange for the decision
  assert.ok(
    /resolveAfterLanguageChange\(/.test(provider),
    "languageChanged handler must call resolveAfterLanguageChange for the decision"
  );
  // Must check hasExplicitPreference for the storage half
  assert.ok(
    /hasExplicitPreference\(\)/.test(provider),
    "languageChanged handler must pass hasExplicitPreference() to resolveAfterLanguageChange"
  );
  // Must pass explicitPreferenceRef as the in-memory flag
  assert.ok(
    /explicitPreferenceRef\.current/.test(provider),
    "languageChanged handler must pass explicitPreferenceRef.current to resolveAfterLanguageChange"
  );
  // Must only update state when the resolved value differs from current
  assert.ok(
    /resolved\s*!==\s*unitSystemRef\.current/.test(provider),
    "languageChanged handler must only update state when resolved differs from current"
  );
  // Must sync both ref and state on change
  assert.ok(
    /unitSystemRef\.current\s*=\s*resolved/.test(provider),
    "languageChanged handler must assign resolved to unitSystemRef.current"
  );
  assert.ok(
    /setUnitSystemState\(resolved\)/.test(provider),
    "languageChanged handler must call setUnitSystemState(resolved)"
  );
});

test("UnitSystemProvider declares explicitPreferenceRef initialized from hasExplicitPreference", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Must declare a useRef with hasExplicitPreference()
  assert.ok(
    /explicitPreferenceRef\s*=\s*useRef\(hasExplicitPreference\(\)\)/.test(provider),
    "UnitSystemProvider must declare explicitPreferenceRef = useRef(hasExplicitPreference())"
  );
});

test("UnitSystemProvider setUnitSystem sets explicitPreferenceRef.current = true", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Find the setUnitSystem callback body
  const setterMatch = provider.match(
    /const\s+setUnitSystem\s*=\s*useCallback\(\s*\(valueOrFn\)\s*=>\s*\{([\s\S]*?)\},\s*\[\]\s*\)/
  );
  assert.ok(setterMatch, "UnitSystemProvider must define setUnitSystem as useCallback([], [])");
  const setterBody = setterMatch[1];
  // Must set explicitPreferenceRef.current = true
  assert.ok(
    /explicitPreferenceRef\.current\s*=\s*true/.test(setterBody),
    "setUnitSystem must set explicitPreferenceRef.current = true on explicit user action"
  );
});

test("UnitSystemProvider imports resolveAfterLanguageChange from unitPreference.js", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  assert.ok(
    /import.*resolveAfterLanguageChange.*from.*unitPreference/.test(provider),
    "UnitSystemProvider must import resolveAfterLanguageChange from unitPreference.js"
  );
});

test("unitPreference.js exports resolveAfterLanguageChange", () => {
  const src = fs.readFileSync(path.join(here, "src/lib/unitPreference.js"), "utf8");
  assert.ok(
    /export function resolveAfterLanguageChange/.test(src),
    "unitPreference.js must export resolveAfterLanguageChange"
  );
});

test("UnitSystemProvider migration re-read syncs unitSystemRef.current", () => {
  const provider = fs.readFileSync(path.join(here, "src/components/UnitSystemProvider.jsx"), "utf8");
  // Anchor in the migration useLayoutEffect body: find the migrateLegacyUnit()
  // call and verify that unitSystemRef.current is assigned within the same
  // conditional branch (the ok === true path), not elsewhere.
  const migrateIdx = provider.indexOf("migrateLegacyUnit()");
  assert.ok(migrateIdx > 0, "migrateLegacyUnit() call not found");
  // The migration effect body runs from migrateLegacyUnit() to the next },[]
  // dependency array.  Extract up to the closing of this useLayoutEffect.
  const effectStart = provider.lastIndexOf("useLayoutEffect", migrateIdx);
  assert.ok(effectStart > 0, "useLayoutEffect not found before migrateLegacyUnit()");
  const depArrayIdx = provider.indexOf("}, [retryCount])", migrateIdx);
  assert.ok(depArrayIdx > 0, "retryCount dependency array not found after migrateLegacyUnit()");
  const migrationBody = provider.slice(effectStart, depArrayIdx + 4);
  assert.ok(
    /unitSystemRef\.current\s*=\s*\w+/.test(migrationBody),
    "Migration useLayoutEffect body must sync unitSystemRef.current after re-reading state"
  );
  // The ref assignment must be inside the `if (ok)` branch, not outside
  const okIdx = migrationBody.indexOf("if (ok)");
  const refIdx = migrationBody.indexOf("unitSystemRef.current =");
  assert.ok(okIdx >= 0 && refIdx > okIdx,
    "unitSystemRef.current assignment must be inside the if (ok) branch of migration"
  );
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
  // The source captures triggerRef?.current into a local then calls .focus()
  // in the effect cleanup — verify both halves of the pattern independently
  // so the assertion is not defeated by multi-line splitting or local aliasing.
  assert.ok(/triggerRef\?\.current/.test(settings), "UnitSettings must snapshot triggerRef.current for cleanup");
  assert.ok(/\.focus\(\)/.test(settings), "UnitSettings must call .focus() in cleanup to restore focus");
});

test("UnitSettings implements keyboard focus trap for Tab/Shift+Tab", () => {
  const settings = fs.readFileSync(path.join(here, "src/components/UnitSettings.jsx"), "utf8");
  // Must handle Tab key events
  assert.ok(/key\s*===\s*"Tab"/.test(settings), "UnitSettings must intercept Tab key events");
  // Must check shiftKey to handle Shift+Tab
  assert.ok(/shiftKey/.test(settings), "UnitSettings must handle Shift+Tab direction");
  // Must have a helper that queries focusable elements within the dialog
  assert.ok(/querySelectorAll/.test(settings), "UnitSettings must query focusable elements for the trap");
  // Must call preventDefault to prevent native tab behavior when wrapping
  assert.ok(/preventDefault/.test(settings), "UnitSettings must call preventDefault to trap focus");
});

// ── TakeoffsPanel input accessibility ────────────────────────────────────────

test("DimParamInput has aria-label including field meaning and current unit", () => {
  const panel = fs.readFileSync(path.join(here, "src/components/TakeoffsPanel.jsx"), "utf8");
  assert.ok(/aria-label=\{kind === "height" \?/.test(panel), "dimension inputs must expose aria-label");
  assert.ok(/takeoffs\.wall_height_aria/.test(panel), "height input must use localized wall_height_aria");
  assert.ok(/takeoffs\.material_thickness_aria/.test(panel), "thickness input must use localized material_thickness_aria");
});

test("GroutParamInput has aria-label from its title prop", () => {
  const panel = fs.readFileSync(path.join(here, "src/components/TakeoffsPanel.jsx"), "utf8");
  assert.ok(/aria-label=\{title\}/.test(panel), "GroutParamInput must pass title as aria-label");
});

test("MaterialRateInput labels coverage using the selected material basis", () => {
  const panel = fs.readFileSync(path.join(here, "src/components/TakeoffsPanel.jsx"), "utf8");
  assert.ok(/const basisUnit = units === "metric"/.test(panel), "coverage labels must derive their unit from the basis");
  assert.ok(/takeoffs\.coverage_rate_aria/.test(panel), "coverage input must use localized coverage_rate_aria");
});

test("Metric roll basis options remain distinguishable", () => {
  const panel = fs.readFileSync(path.join(here, "src/components/TakeoffsPanel.jsx"), "utf8");
  assert.ok(/takeoffs\.roll_metric_sy_basis/.test(panel), "metric SY basis must use i18n key, not hardcoded");
  assert.ok(/takeoffs\.roll_metric_sf_basis/.test(panel), "metric SF basis must use i18n key, not hardcoded");
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

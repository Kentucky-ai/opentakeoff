# Global Unit System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-global Imperial/SI preference that updates new and existing projects while preserving the existing Imperial canonical data contract.

**Architecture:** Keep geometry, persisted quantities, and calculation inputs canonical in Imperial (`ft`, `ft²`, `in`). Add a small preference store/provider for the global `imperial | metric` selection, then make UI/report/export boundaries consume the selected system through the existing conversion helpers in `web/src/lib/units.ts`.

**Tech Stack:** React, TypeScript/JavaScript, localStorage, Node `node:test`, Vite.

---

## Files and Responsibilities

- Create `web/src/lib/unitPreference.js` — validated global preference read/write and browser-storage fallback.
- Create `web/src/components/UnitSystemProvider.jsx` — reactive context/hook shared by the app, canvas, reports, and settings.
- Create `web/src/components/UnitSettings.jsx` — settings control for Imperial/SI.
- Create `web/test/unitPreference.test.ts` — persistence, fallback, and validation tests.
- Modify `web/src/lib/units.ts` — complete canonical/display/input helpers and round-trip-safe conversions.
- Modify `web/src/main.jsx` — provide the global unit system to the application.
- Modify `web/src/pages/TakeoffCanvas.jsx` — consume the unit system for canvas controls/readouts and pass it to report/settings surfaces; keep shape metrics canonical.
- Modify `web/src/components/ReportPanel.jsx` — render report values and export labels in the selected system.
- Modify `web/src/lib/reportColumns.js` — ensure all dimensional columns, including roll and waste columns, convert exactly once.
- Modify `web/src/lib/markedset.js` and other numeric export/display consumers found by the unit audit — convert displayed labels without changing stored values.
- Create or modify `web/test/units.test.ts` — conversion and formatting tests.
- Modify `web/test/shapeMetrics.test.ts`, `web/test/totals.test.ts`, and `web/test/reportColumns.test.ts` — calculation invariance and output-unit tests.
- Modify `README.md`, `docs/USER_GUIDE.md`, and `CHANGELOG.md` — document the global setting, supported units, and canonical-storage behavior.

## Task 1: Establish preference storage and unit-boundary helpers

**Files:**
- Create: `web/src/lib/unitPreference.js`
- Modify: `web/src/lib/units.ts`
- Create: `web/test/unitPreference.test.ts`
- Modify: `web/test/units.test.ts`

- [ ] **Step 1: Write failing preference tests**

Cover these exact cases with an injected storage stub:

```ts
const storage = {
  value: "metric",
  getItem: () => storage.value,
  setItem: (_key, value) => { storage.value = value; },
};
assert.equal(readUnitSystem(storage), "metric");
storage.value = "bogus";
assert.equal(readUnitSystem(storage), "imperial");
assert.equal(normalizeUnitSystem("metric"), "metric");
assert.equal(normalizeUnitSystem("bogus"), "imperial");
```

Also test that `writeUnitSystem("metric")` persists exactly `metric`, while a storage write exception does not throw.

- [ ] **Step 2: Write failing conversion tests**

Assert the existing and new helpers use the canonical contract:

```ts
assert.equal(areaVal(100, "metric"), 9.290304);
assert.equal(lenVal(10, "metric"), 3.048);
assert.equal(heightVal(10, "metric"), 3.048);
assert.equal(thickVal(1, "metric"), 25.4);
assert.equal(heightInputToFeet(3.048, "metric"), 10);
assert.equal(thickInputToInches(25.4, "metric"), 1);
```

Add round-trip assertions with an epsilon rather than exact equality for floating-point values.

- [ ] **Step 3: Implement the preference module**

Export the following stable API:

```js
export const UNIT_SYSTEM_KEY = "opentakeoff.unitSystem";
export const DEFAULT_UNIT_SYSTEM = "imperial";
export function normalizeUnitSystem(value) {
  return value === "metric" ? "metric" : "imperial";
}
export function readUnitSystem(storage = globalThis.localStorage) {
  try { return normalizeUnitSystem(storage?.getItem(UNIT_SYSTEM_KEY)); }
  catch { return DEFAULT_UNIT_SYSTEM; }
}
export function writeUnitSystem(value, storage = globalThis.localStorage) {
  const next = normalizeUnitSystem(value);
  try { storage?.setItem(UNIT_SYSTEM_KEY, next); } catch { /* keep in memory */ }
  return next;
}
```

Catch both unavailable storage and storage exceptions. Do not silently accept arbitrary strings.

- [ ] **Step 4: Complete `units.ts` helpers**

Keep `UnitSystem = "imperial" | "metric"`, preserve the existing conversion constants, and add only missing inverse/display helpers required by consumers. Do not introduce alternate SI calculation functions. Keep height in meters and thickness in millimeters for metric display/input.

- [ ] **Step 5: Run focused tests**

Run from `web/`:

```bash
npm test -- test/unitPreference.test.ts test/units.test.ts
```

Expected: all new preference/conversion tests pass.

- [ ] **Step 6: Commit the boundary layer**

```bash
git add web/src/lib/unitPreference.js web/src/lib/units.ts web/test/unitPreference.test.ts web/test/units.test.ts
git commit -m "feat: add global unit preference boundary"
```

## Task 2: Add reactive global application state and settings UI

**Files:**
- Create: `web/src/components/UnitSettings.jsx`
- Modify: `web/src/main.jsx`
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/public/locales/en/panels.json`
- Modify: `web/public/locales/pt-br/panels.json`

- [ ] **Step 1: Write the state contract before UI changes**

Implement `UnitSystemProvider` and `useUnitSystem` as the single source of truth with this behavior:

```ts
const { unitSystem, setUnitSystem } = useUnitSystem();
```

The initial value must come from `readUnitSystem()`, and `setUnitSystem` must persist and notify all consumers in the same render cycle. Mount `UnitSystemProvider` inside `App` above the `ProjectGate`/`ProjectHome` branch so both local and cloud project routes consume it.

- [ ] **Step 2: Implement the settings control**

Create a controlled radio/select control with exactly these labels:

```text
Imperial — SF, LF, ft, in
SI/Métrico — m², m, m, mm
```

Use existing panel classes/tokens and i18n namespaces. The control must be keyboard accessible, expose its current selection, and not close or reset unrelated settings.

- [ ] **Step 3: Mount the control in the existing settings surface**

Add `UnitSettings` to the existing settings/preferences entry point rather than creating a new navigation route. Ensure it is visible for both a new local project and an opened existing project.

- [ ] **Step 4: Verify live switching manually**

Start the app with `npm run dev`, switch Imperial → SI/Métrico → Imperial, and confirm the setting changes without reload and remains after a page reload.

- [ ] **Step 5: Commit the application setting**

```bash
git add web/src/components/UnitSettings.jsx web/src/main.jsx web/src/pages/TakeoffCanvas.jsx web/public/locales
git commit -m "feat: expose global unit system setting"
```

## Task 3: Audit input boundaries and preserve canonical calculations

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx`
- Modify: `web/src/lib/shapeMetrics.js`
- Modify: `web/src/lib/totals.js` only where a display conversion is incorrectly mixed into aggregation
- Modify: `web/test/shapeMetrics.test.ts`
- Modify: `web/test/totals.test.ts`

- [ ] **Step 1: Add failing Surface Area invariance tests**

For the same physical wall, compare Imperial input and equivalent metric input:

```ts
const imperial = computeSurfaceArea({ lengthFt: 10, heightFt: 8 });
const metricInput = computeSurfaceArea({ lengthM: 3.048, heightM: 2.4384 });
assert.ok(Math.abs(imperial.sf - metricInput.sf) < 0.000001);
```

Use the repository's actual `computeShapeMetrics` shape/dims/upp contract in the test; the pseudocode above specifies the invariant, not a new production API.

- [ ] **Step 2: Convert height and thickness at edit/input edges**

When SI is selected:

```js
const heightFt = heightInputToFeet(Number(inputValue), unitSystem);
const thicknessIn = thickInputToInches(Number(inputValue), unitSystem);
```

Persist only `height_ft` and `thickness_in`. When rendering existing values, use `heightVal` and `thickVal` and the selected unit labels. Do not convert a stored value in place during render.

- [ ] **Step 3: Keep `surface_area` canonical**

`computeShapeMetrics` must continue to calculate `openLen(pts) * upp` in LF and multiply by canonical feet height. A unit switch must not change `verts_norm`, `computed.area_sf`, or `computed.perimeter_lf`.

- [ ] **Step 4: Verify totals remain canonical**

`accumulateRole` and `conditionTotals` must continue summing SF/LF values without metric conversion. Add tests proving the same stored shapes produce the same canonical totals before and after a unit preference switch.

- [ ] **Step 5: Run focused geometry/totals tests**

```bash
npm test -- test/shapeMetrics.test.ts test/geometry.test.ts test/totals.test.ts
```

- [ ] **Step 6: Commit canonical-boundary changes**

```bash
git add web/src/pages/TakeoffCanvas.jsx web/src/lib/shapeMetrics.js web/src/lib/totals.js web/test/shapeMetrics.test.ts web/test/totals.test.ts
git commit -m "feat: localize unit inputs without changing canonical math"
```

## Task 4: Apply selected units to reports and exports exactly once

**Files:**
- Modify: `web/src/lib/reportColumns.js`
- Modify: `web/src/components/ReportPanel.jsx`
- Modify: report/export modules that call `applyUnits`, `totalsToCsv`, `reportWorkbook`, or shape export helpers
- Modify: `web/test/reportColumns.test.ts`

- [ ] **Step 1: Add failing report conversion tests**

Assert every dimensional report column converts in metric mode and non-dimensional columns remain unchanged:

```ts
const cols = applyUnits([{ key: "wall_sf", label: "Wall SF", get: () => 100 }, { key: "ea", label: "EA", get: () => 2 }], "metric");
assert.equal(cols.find((c) => c.key === "wall_sf").get({}), 9.29);
assert.equal(cols.find((c) => c.key === "ea").get({}), 2);
```

Cover `floor_sf`, `wall_sf`, `border_sf`, `total_sf`, waste/net SF, LF columns, roll LF/seam LF, and the existing `sy_net` behavior.

- [ ] **Step 2: Thread `unitSystem` through ReportPanel and exporters**

Use one selected system per render/export operation. Do not pass already-converted values into a second `applyUnits` call. CSV/XLSX labels must be `m2`/`m` in metric mode and existing Imperial labels otherwise.

- [ ] **Step 3: Audit numeric shape/marked-set labels**

Update `shapesExport`, `markedset`, and any report-side shape detail/chip code so area/length labels use `areaVal`/`lenVal` and selected units. Leave internal JSON fields canonical unless the export contract explicitly defines human-readable display columns.

- [ ] **Step 4: Run report/export tests**

```bash
npm test -- test/reportColumns.test.ts test/shapesExport.test.ts
```

- [ ] **Step 5: Commit report/export support**

```bash
git add web/src/lib/reportColumns.js web/src/components/ReportPanel.jsx web/src/lib/shapesExport.js web/src/lib/markedset.js web/test/reportColumns.test.ts
git commit -m "feat: localize reports and exports by unit system"
```

## Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/USER_GUIDE.md`
- Modify: `CHANGELOG.md`
- Modify: tests discovered by the unit audit

- [ ] **Step 1: Document the setting**

Explain that the preference is global to the browser, applies to existing and new projects, defaults to Imperial, and does not rewrite stored takeoff quantities. Document the mapping:

```text
Imperial: SF, LF, ft, in
SI/Métrico: m², m, m, mm
```

- [ ] **Step 2: Add the user-facing changelog entry**

Describe SI/Métrico support, Surface Area behavior, and the fact that values are converted at input/display boundaries.

- [ ] **Step 3: Run the required project check**

From `web/`:

```bash
npm run check
```

Expected: typecheck, lint, tests, and build all pass.

- [ ] **Step 4: Perform the manual acceptance path**

1. Open an existing sample project in Imperial.
2. Set a scale and create a Surface Area wall using a known length and height.
3. Record the displayed LF/SF and Report totals.
4. Switch to SI/Métrico and confirm the expected m/m² values.
5. Edit height and thickness in SI and confirm the stored/reloaded calculation is physically equivalent.
6. Reload the page and confirm SI remains selected.
7. Create/open another project and confirm it inherits SI.
8. Export CSV/XLSX and confirm metric headers and values.
9. Switch back to Imperial and confirm no geometry or canonical quantity changed.

- [ ] **Step 5: Inspect final diff and status**

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD --check
```

Expected: only the unit-system implementation, tests, and synchronized documentation are changed; no whitespace errors are reported.

- [ ] **Step 6: Commit documentation and the verified feature**

```bash
git add README.md docs/USER_GUIDE.md CHANGELOG.md web
git commit -m "feat: support global Imperial and SI units"
```

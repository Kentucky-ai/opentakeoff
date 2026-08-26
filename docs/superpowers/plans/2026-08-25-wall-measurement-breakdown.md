# Wall Measurement Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show individual line and wall-polyline measurements in the canvas readout, including length, height, and calculated area where applicable.

**Architecture:** Derive a readout-only list from the existing `visibleShapes`, active condition, and stored `computed` values in `TakeoffCanvas.jsx`. Do not change shape persistence or totals math. Render the list beneath the existing total values, using current unit formatters and the shape-specific height fallback rules.

**Tech Stack:** React JSX, existing canvas geometry/computed shape model, i18next translations, Vite build, Node tests.

---

### Task 1: Add readout measurement derivation

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx:5680-5710`

- [ ] **Step 1: Derive eligible measurements from existing visible shapes**

Add a memoized readout collection beside `lfTotal` and `wallTotal`:

```jsx
const readoutMeasurements = useMemo(() => visibleShapes
  .filter((s) => s.condition_id === activeCond && (s.measure_role === "linear" || s.measure_role === "surface_area"))
  .map((s, index) => {
    const lengthLf = s.computed?.perimeter_lf || 0;
    const heightFt = s.measure_role === "surface_area"
      ? (s.height_ft ?? aCond?.height_ft ?? 0)
      : 0;
    const areaSf = s.measure_role === "surface_area"
      ? lengthLf * heightFt
      : (s.computed?.area_sf || 0);
    return { shape: s, index, lengthLf, heightFt, areaSf };
  })
  .filter(({ lengthLf, areaSf }) => lengthLf > 0 || areaSf > 0),
  [visibleShapes, activeCond, aCond?.height_ft]);
```

Use the existing condition/visibility scope so the list matches the card's active context. Keep `surface_area` height precedence shape-specific, then condition default.

- [ ] **Step 2: Confirm the derived list uses existing computed geometry**

Run:

```bash
cd web
npm test
```

Expected: existing geometry and totals tests pass; no test should require a persistence change because this is readout-only derivation.

### Task 2: Render the measurement breakdown

**Files:**
- Modify: `web/src/pages/TakeoffCanvas.jsx:7580-7595`
- Modify: `web/public/locales/pt-br/canvas.json`
- Modify: `web/public/locales/en/canvas.json`

- [ ] **Step 1: Add translated section labels and empty-safe formatting**

Add these translation keys:

```json
"readout.measurements": "Medições",
"readout.measurement_length": "linear",
"readout.measurement_area": "área"
```

Add equivalent English values in `en/canvas.json`.

- [ ] **Step 2: Render the compact list below the totals**

Insert below the existing total lines and before the shape/sheet footer:

```jsx
{readoutMeasurements.length > 0 && (
  <div style={{ marginTop: 9, paddingTop: 7, borderTop: "1px solid var(--divider-soft)" }}>
    <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55, marginBottom: 4 }}>
      {t('readout.measurements')}
    </div>
    {readoutMeasurements.map(({ shape, index, lengthLf, heightFt, areaSf }) => (
      <div key={shape.id} style={{ display: "flex", alignItems: "baseline", gap: 5, fontSize: 11.5, lineHeight: 1.55, fontFamily: "var(--f-mono)", fontVariantNumeric: "tabular-nums" }}>
        <span style={{ width: 20, color: "var(--ink-muted)" }}>{String(index + 1).padStart(2, "0")}</span>
        <span>{fl(lengthLf)}</span>
        {shape.measure_role === "surface_area" ? (
          <><span>× {num(heightVal(heightFt, units), 2)} {heightUnit(units)} = {fa(areaVal(areaSf, units))} {areaUnit(units)}</span></>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>{t('readout.measurement_length')}</span>
        )}
      </div>
    ))}
  </div>
)}
```

Use the existing `fl`, `fa`, `heightVal`, `heightUnit`, `areaVal`, and `areaUnit` helpers already used by the readout. Keep line measurements distinct from wall polylines: lines show length, while `surface_area` shows length × height = area.

- [ ] **Step 3: Validate the UI manually with the sample plan**

Run:

```bash
cd web
npm run dev
```

Load the sample plan, set an active condition height, create one linear measurement and one wall measurement, and verify the readout contains:

```text
Medições
01  <length> linear
02  <length> × <height> = <area>
```

Change the wall shape's height override and confirm the individual area changes while the fallback condition height remains unchanged for shapes without an override.

### Task 3: Run final verification

**Files:**
- No additional files.

- [ ] **Step 1: Run the project check**

Run:

```bash
cd web
npm run check
```

Expected: typecheck, lint, tests, and production build pass. The existing large-chunk warning is acceptable if no new error appears.

- [ ] **Step 2: Check formatting and working tree**

Run:

```bash
git diff --check
```

Expected: no whitespace errors; only the planned source, translation, and documentation files are changed.

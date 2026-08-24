# Global Unit System Design

## Goal

Add a global Imperial/SI unit preference that applies immediately to new and existing projects while keeping the persisted takeoff data in a stable Imperial canonical contract.

## Decisions

- The preference is global to the browser, not stored separately per project.
- The preference is persisted in `localStorage` under `opentakeoff.unitSystem`.
- The default and fallback value is `imperial`.
- Supported values are `imperial` and `metric` (the UI label is SI/Métrico).
- Existing and new projects use the current global preference.
- The canonical persisted contract remains Imperial:
  - length: feet (`ft`)
  - area: square feet (`ft²` / `SF`)
  - height: feet (`ft`)
  - thickness: inches (`in`)
- Metric values are converted at input boundaries and canonical values are converted at display/export boundaries.
- Canonical values must not be rewritten merely because the preference changes.
- Internal calculations retain full precision where practical; rounding is deferred to presentation/export boundaries.

## Unit Mapping

| Dimension | Imperial | SI/Métrico |
|---|---|---|
| Area | SF | m² |
| Length | LF | m |
| Wall height | ft | m |
| Material thickness | in | mm |

The existing conversion constants are authoritative: `0.3048 m/ft`, `0.09290304 m²/SF`, and `25.4 mm/in`.

## Architecture and Data Flow

`web/src/lib/units.ts` remains the central unit boundary. It owns the `UnitSystem` type, constants, display conversions, and input conversions. The application-level state reads the global preference at startup, validates it, and falls back to Imperial when it is absent, invalid, or storage is unavailable.

The settings UI exposes a radio/select control for:

- Imperial — SF, LF, ft, in
- SI/Métrico — m², m, m, mm

Changing the setting updates the application state immediately and causes display-only values to rerender. No geometry, `computed.area_sf`, `perimeter_lf`, `height_ft`, or other canonical persisted values are migrated.

## Calculation Semantics

Geometry calculations remain canonical:

```text
Surface Area:
LF = open polyline pixel length × feet-per-pixel
SF = LF × height in feet
```

In SI mode, the resulting canonical values are converted for the UI, reports, exports, and marked-set numeric labels. Metric input for height and thickness is converted to feet and inches respectively before entering the calculation/storage layer.

The implementation must avoid double conversion and must not round a value before a subsequent calculation when the unrounded canonical value is available.

## Scope

The unit preference and conversion audit covers:

- floor area, deductions, surface/wall area, and linear measurements;
- waste, net totals, border quantities, roll quantities, and related report columns;
- Surface Area height input and material thickness input;
- Report UI, CSV/XLSX exports, marked-set/PDF numeric labels, and auxiliary readouts that expose quantities;
- existing project loading and new project initialization.

Files expected to participate include `web/src/lib/units.ts`, `web/src/lib/shapeMetrics.js`, `web/src/lib/totals.js`, `web/src/lib/reportColumns.js`, `web/src/pages/TakeoffCanvas.jsx`, `web/src/components/ReportPanel.jsx`, `web/src/lib/store.js`, relevant tests, and synchronized user documentation (`README.md`, `docs/USER_GUIDE.md`, `CHANGELOG.md`). The exact set is confirmed during implementation by tracing current unit consumers.

## Validation and Failure Handling

- Invalid or missing preference: use Imperial.
- `localStorage` unavailable: keep the preference in memory and continue in Imperial if it cannot be read.
- Reject negative/non-numeric height and thickness inputs using existing field validation patterns.
- Preserve the existing scale gate for geometry measurements.
- Test conversion round trips, Imperial-vs-SI equivalent calculations, Surface Area, persistence, live switching, reports, and exports.
- Run `npm run check` and manually verify an existing project, a new Surface Area trace, the Report, and an export after switching units.

## Non-Goals

- Per-project unit overrides.
- Migrating persisted geometry or quantities to SI.
- Changing the meaning of scale calibration or PDF pixel coordinates.
- Introducing a second calculation engine for SI.

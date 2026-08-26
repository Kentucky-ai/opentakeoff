# Readout tally — MEASUREMENTS under the condition total

**Date:** 2026-08-26 · **Status:** shipped

## Why
An estimator builds a total by tallying lines, then checks the total by re-reading the lines. The readout card showed only the sum; checking a wall-tile SF meant selecting each wall in turn or opening the Takeoffs panel. The card is where the eye already is while tracing.

## What
Under the `<TAG> TOTAL` block, when the active condition has any linear or wall shapes on the visible sheets:

```
MEASUREMENTS
01 47.2 LF linear
02 27.4 LF linear
03 39.1 LF × 8 ft = 313.1 SF
```

- Draw order (array order of committed shapes), numbered from 01.
- `linear` rows: `perimeter_lf` as stored.
- `surface_area` rows: `LF × H = SF`. Height rule = the readout's own selected-shape rule: `height_override === true` → the shape's height; else shape height, else condition height. SF is the stored `area_sf` (falls back to `LF × H` only when a shape carries no stored area).
- Floor areas, deducts and counts are not listed — a ring is checked by looking at it.
- Units go through the same `fl` / `fa` / `heightVal` edges as the rest of the card, so metric converts per line.

## Where
- `web/src/lib/measurementBreakdown.js` — pure `measurementBreakdown(shapes, conditionId, cond)` + `wallHeightFt`. No React, no DOM.
- `web/test/measurementBreakdown.test.ts` — 5 tests: order/numbering, role filter, height precedence, SF fallback, null safety.
- `web/src/pages/TakeoffCanvas.jsx` — one `useMemo` over `visibleShapes` + the JSX block above the card footer. Mono tabular numerals (`--f-mono`), `nowrap` rows.

## Verified live
Sample plan AF101 at 1/8" = 1'-0", CPT-1 H=8: two Linear runs + one Surface wall → `74.6 LF` and `313.1 SF wall` totals equal the three listed lines; `ft`→`m` toggle re-reads as `11.9 m × 2.44 m = 29.1 m²`.

## Provenance
Idea and line format from a downstream fork's spec (replicant026/fork-opentakeoff, seen in mis-targeted PR #341, closed by its author). Implemented independently — no code taken.

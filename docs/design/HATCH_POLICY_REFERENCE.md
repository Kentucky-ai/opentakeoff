# Hatch-family reference policy

This experiment tests an alternative policy around the current One-Click hatch primitives. It is a reviewable model, not a production replacement. OpenTakeoff does not import `hatchPolicyReference.js` from the room engine.

The reference answers three questions:

1. Which line segments fit one normal-offset lattice?
2. Does trusted provenance or context support calling that family hatch, a repeated building element, or uncertain?
3. If a hatch family trapped the strict flood, may a transparent retry replace it without losing rooms or crossing protected geometry?

## Detection contract

`proposeLineFamilies` groups segments by sheet-local stroke width and angle modulo pi. It normalizes coordinates against a robust sheet scale, merges split pieces into rows, and fits pitch and phase with missing-row tolerance. The fit reports row and capped-length inlier rates, occupancy, residual, spatial span, and member IDs.

`analyzeLineFamilies` also reports every unassigned segment ID. The caller can therefore audit which source geometry the proposal stage ignored.

The reference does not fit tangential dash recurrence. The split-row carpet fixture proves only that collinear fragments do not receive extra row votes. Do not use this module as evidence of dash-phase support.

## Classification contract

`classifyLineFamily` returns `hatch`, `repeated-building-element`, or `uncertain`.

Native hatch provenance is accepted only when every family member belongs to the same extractor group and the caller supplies that group through a separate trusted set. Caller-authored segment fields cannot mark themselves trusted. Flattened geometry requires separately trusted clip or fill evidence. Geometry alone remains uncertain because a periodic partition bank can be identical to hatch after flattening.

Paired support rails protect stair treads and similar repeated construction. Orthogonal grids remain uncertain. The synthetic corpus also keeps dimension ticks, ceiling grids, shelving-like banks, and irregular parallel lines out of the hatch label.

## Retry contract

`gateTransparentRetry` keeps both the strict result and the transparent candidate in its decision record. Only a testable hatch decision with finite confidence may request a retry.

The retry fails closed when metrics are missing or when it leaks, creates invalid polygons, exceeds the area-growth budget, loses wall support or coverage, overlaps a protected class, increases downstream errors, loses or traps a seed, fails to recover a formerly trapped seed, or changes the room split and merge relation.

The defaults are test values, not recommended production thresholds. Tune them on projects that stay separate from final held-out sheets. Report every protected-class failure and every retry that is worse than the strict result, even when aggregate hatch recall improves.

The first run against the repository's own extracted vectors did not clear the real-sheet bar. See [HATCH_POLICY_REFERENCE_VERIFICATION.md](HATCH_POLICY_REFERENCE_VERIFICATION.md). The current extractor does not emit the trusted group or evidence identifiers this classifier requires, the raw real sheet contains degenerate segments the proposal stage rejects, and the filtered full-sheet proposal exceeded its declared time budget. Keep this as a negative-control reference unless those failures are addressed and re-measured.

## Run the checks

From `web/`:

```sh
node --import tsx --test test/hatchPolicyReference.test.ts
```

The full repository check remains the merge gate:

```sh
npm run check
```

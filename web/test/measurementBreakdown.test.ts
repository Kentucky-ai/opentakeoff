// measurementBreakdown.js — the pure derivation for the readout card's
// individual-measurement list.  Tests cover: linear length, surface
// shape-height override vs condition-height fallback, metric-independent
// stored-feet / derived-area math, and filtering of unrelated or empty shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadoutMeasurements } from "../src/lib/measurementBreakdown.js";

// ── types ────────────────────────────────────────────────────────────
interface MinimalShape {
  id?: string;
  condition_id?: string;
  measure_role?: string;
  height_ft?: number;
  height_override?: boolean;
  computed?: {
    perimeter_lf?: number;
    area_sf?: number;
    count?: number;
  };
}

interface ReadoutRow {
  shape: MinimalShape;
  index: number;
  lengthLf: number;
  heightFt: number;
  areaSf: number;
}

// ── helpers ──────────────────────────────────────────────────────────
const APPROX = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/** Minimal shape factory. */
const shape = (overrides: Partial<MinimalShape>): MinimalShape => ({
  id: "s1",
  condition_id: "condA",
  measure_role: "floor_area",
  computed: { perimeter_lf: 0, area_sf: 0 },
  ...overrides,
});

// ── linear ───────────────────────────────────────────────────────────
test("linear row: lengthLf from computed perimeter, areaSf from computed area_sf", () => {
  const s = shape({
    id: "lin1",
    measure_role: "linear",
    computed: { perimeter_lf: 12.5, area_sf: 3.75 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 8) as ReadoutRow[];
  assert.equal(row.shape.id, "lin1");
  assert.equal(row.index, 0);
  assert.ok(APPROX(row.lengthLf, 12.5));
  assert.ok(APPROX(row.areaSf, 3.75));
  assert.equal(row.heightFt, 0);
});

test("linear row with zero perimeter AND zero area is excluded", () => {
  const s = shape({
    measure_role: "linear",
    computed: { perimeter_lf: 0, area_sf: 0 },
  });
  assert.equal(buildReadoutMeasurements([s], "condA", 8).length, 0);
});

// ── surface_area: height override vs condition fallback ───────────────
test("surface_area: shape height_override wins", () => {
  const s = shape({
    id: "sa1",
    measure_role: "surface_area",
    height_ft: 9,
    height_override: true,
    computed: { perimeter_lf: 10 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 5) as ReadoutRow[];
  assert.ok(APPROX(row.heightFt, 9));
  assert.ok(APPROX(row.lengthLf, 10));
  assert.ok(APPROX(row.areaSf, 90));
});

test("surface_area: falls back to condition height when no shape height", () => {
  const s = shape({
    id: "sa2",
    measure_role: "surface_area",
    height_ft: 0,
    computed: { perimeter_lf: 8 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 6) as ReadoutRow[];
  assert.ok(APPROX(row.heightFt, 6));
  assert.ok(APPROX(row.areaSf, 48));
});

test("surface_area: height_override true with height_ft 0 stays 0 (explicit zero)", () => {
  const s = shape({
    measure_role: "surface_area",
    height_ft: 0,
    height_override: true,
    computed: { perimeter_lf: 10 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 7) as ReadoutRow[];
  assert.ok(APPROX(row.heightFt, 0));
  assert.ok(APPROX(row.areaSf, 0));
  // lengthLf > 0 so the row is still included
  assert.ok(row);
});

// ── metric-independent stored-feet / derived-area ─────────────────────
test("areaSf is always in stored feet regardless of display units", () => {
  // internal math: lengthLf=15 ft, heightFt=10 ft → areaSf=150 SF
  // This must be 150 whether the user shows metric or imperial.
  const s = shape({
    measure_role: "surface_area",
    height_ft: 10,
    height_override: true,
    computed: { perimeter_lf: 15 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 8) as ReadoutRow[];
  assert.ok(APPROX(row.areaSf, 150));
});

// ── filtering ─────────────────────────────────────────────────────────
test("shapes with a different condition_id are excluded", () => {
  const s = shape({ condition_id: "condB", measure_role: "linear", computed: { perimeter_lf: 5 } });
  assert.equal(buildReadoutMeasurements([s], "condA", 8).length, 0);
});

test("count and floor_area shapes are excluded", () => {
  const c = shape({ measure_role: "count", computed: { count: 3 } });
  const f = shape({ id: "f1", measure_role: "floor_area", computed: { perimeter_lf: 40, area_sf: 200 } });
  assert.equal(buildReadoutMeasurements([c, f], "condA", 8).length, 0);
});

test("activeCond null returns nothing", () => {
  const s = shape({ measure_role: "linear", computed: { perimeter_lf: 5 } });
  assert.equal(buildReadoutMeasurements([s], null, 8).length, 0);
});

test("indices are sequential across mixed roles", () => {
  const s1 = shape({ id: "lin1", measure_role: "linear", computed: { perimeter_lf: 5 } });
  const s2 = shape({ id: "sa1", measure_role: "surface_area", height_ft: 4, height_override: true, computed: { perimeter_lf: 6 } });
  const s3 = shape({ id: "lin2", measure_role: "linear", computed: { perimeter_lf: 7 } });
  const rows = buildReadoutMeasurements([s1, s2, s3], "condA", 8) as ReadoutRow[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].index, 0);
  assert.equal(rows[1].index, 1);
  assert.equal(rows[2].index, 2);
});

test("linear shape retained when perimeter is zero but area_sf is positive (thickness-derived border)", () => {
  const s = shape({ measure_role: "linear", computed: { perimeter_lf: 0, area_sf: 2.5 } });
  const rows = buildReadoutMeasurements([s], "condA", 8) as ReadoutRow[];
  assert.equal(rows.length, 1);
  assert.ok(APPROX(rows[0].lengthLf, 0));
  assert.ok(APPROX(rows[0].areaSf, 2.5));
});

// ── canonical area preservation ───────────────────────────────────────
test("surface_area uses canonical computed.area_sf rather than recomputing from rounded perimeter", () => {
  // perimeter_lf is already rounded to 2dp by shapeMetrics (10.01), height 2 ft.
  // Canonical area = 20.03; a naive recompute from 10.01 × 2 = 20.02 would drift.
  const s = shape({
    id: "sa_precise",
    measure_role: "surface_area",
    height_ft: 2,
    height_override: true,
    computed: { perimeter_lf: 10.01, area_sf: 20.03 },
  });
  const [row] = buildReadoutMeasurements([s], "condA", 5) as ReadoutRow[];
  assert.ok(APPROX(row.areaSf, 20.03), `expected canonical 20.03, got ${row.areaSf}`);
  assert.ok(APPROX(row.lengthLf, 10.01));
});

test("surface_area falls back to perimeter × height when computed.area_sf is absent", () => {
  const s = shape({
    measure_role: "surface_area",
    height_ft: 4,
    height_override: true,
    computed: { perimeter_lf: 10 },  // no area_sf
  });
  const [row] = buildReadoutMeasurements([s], "condA", 8) as ReadoutRow[];
  assert.ok(APPROX(row.areaSf, 40), `expected fallback 40, got ${row.areaSf}`);
});

test("surface_area preserves canonical area_sf = 0 rather than recomputing fallback", () => {
  // A shape where computed.area_sf was explicitly set to 0 by shapeMetrics
  // (e.g. zero-height wall). ?? does not replace 0, so the row keeps the
  // canonical value instead of recomputing 10 × 0 → 0 through the fallback.
  const s = shape({
    measure_role: "surface_area",
    height_ft: 5,
    height_override: true,
    computed: { perimeter_lf: 10, area_sf: 0 },
  });
  const rows = buildReadoutMeasurements([s], "condA", 8) as ReadoutRow[];
  // lengthLf > 0 so the row is still included despite areaSf = 0
  assert.equal(rows.length, 1);
  assert.ok(APPROX(rows[0].areaSf, 0), `expected canonical 0, got ${rows[0].areaSf}`);
});

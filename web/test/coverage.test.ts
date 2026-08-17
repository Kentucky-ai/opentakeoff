import { test } from "node:test";
import assert from "node:assert/strict";
// coverage.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { materialKind, MATERIAL_PRESETS, GROUT_DEFAULTS, GROUT_PARAM_KEYS, groutCoverageSfPerBag, groutDerivedFields, groutParamsEqual, groutNote, inFrac, showsGroutCalc, showsGroutDeriveAffordance, baseGroutParams, baseGroutNote, isLinearGrout, groutRateStale, baseCourses } from "../src/lib/coverage.js";

const within = (actual: number, expected: number, tolPct: number) =>
  Math.abs(actual - expected) <= expected * (tolPct / 100);

// 12×24 tile, 3/8″ thick, 1/8″ joint — the classic large-format wall/floor case.
const BASE = { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125 };

test("grout coverage: known vectors for a 12×24×3/8″ tile @ 1/8″ joint", () => {
  const sf10 = groutCoverageSfPerBag({ ...BASE, bagLbs: 10 });
  const sf25 = groutCoverageSfPerBag({ ...BASE, bagLbs: 25 });
  assert.ok(within(sf10, 207, 2), `10 lb bag → ${sf10} SF, expected ≈207 ±2%`);
  assert.ok(within(sf25, 518, 2), `25 lb bag → ${sf25} SF, expected ≈518 ±2%`);
});

test("grout coverage: halving the joint exactly doubles coverage (and vice versa)", () => {
  const at = (joint: number) => groutCoverageSfPerBag({ ...BASE, joint, bagLbs: 25 });
  assert.equal(at(1 / 32), 2 * at(1 / 16));   // 1/32″ vs 1/16″ → exactly 2×
  assert.equal(at(0.5), at(0.25) / 2);        // 1/2″ vs 1/4″ → exactly half
});

test("grout coverage: strictly decreasing as the joint widens", () => {
  const joints = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 3 / 8, 1 / 2];
  const cov = joints.map((joint) => groutCoverageSfPerBag({ ...BASE, joint, bagLbs: 25 }));
  for (let i = 1; i < cov.length; i++) {
    assert.ok(cov[i] < cov[i - 1], `coverage must fall: joint ${joints[i]} → ${cov[i]} !< ${cov[i - 1]}`);
  }
});

test("grout coverage: any non-positive parameter → 0, never NaN/Infinity", () => {
  const good = { ...GROUT_DEFAULTS };
  for (const key of ["tileL", "tileW", "tileT", "joint", "bagLbs"] as const) {
    assert.equal(groutCoverageSfPerBag({ ...good, [key]: 0 }), 0, `${key}=0`);
    assert.equal(groutCoverageSfPerBag({ ...good, [key]: -1 }), 0, `${key}=-1`);
  }
});

test("grout defaults round to the CT-1 seed rate (512 SF/bag)", () => {
  assert.equal(Math.round(groutCoverageSfPerBag(GROUT_DEFAULTS)), 512);
});

test("materialKind: name regex classifies mortar / grout / adhesive", () => {
  assert.equal(materialKind({ name: "Thin-set" }), "mortar");
  assert.equal(materialKind({ name: "Grout" }), "grout");
  assert.equal(materialKind({ name: "Cove base adhesive" }), "adhesive");
});

test("materialKind: an explicit kind wins over the name", () => {
  assert.equal(materialKind({ name: "Grout", kind: "mortar" }), "mortar");
});

test("materialKind: unknown names (and empty input) → \"\"", () => {
  assert.equal(materialKind({ name: "Polyurethane (2K finish)" }), "");
  assert.equal(materialKind({}), "");
  assert.equal(materialKind(undefined), "");
});

test("presets: every kind with a preset table has positive generic rates", () => {
  for (const [kind, list] of Object.entries(MATERIAL_PRESETS)) {
    assert.ok((list as any[]).length > 0, kind);
    for (const p of list as any[]) {
      assert.ok(p.label && p.per > 0, `${kind}: ${p.label}`);
    }
  }
});

// ── groutDerivedFields: the derive-only-when-valid rule ─────────────────────
// (adversarial review findings 5/8: a cleared tile dimension used to commit
// per=0 and a "0×24×…" note, silently zeroing grout in every export)

test("groutDerivedFields: valid geometry → rounded per + derivation note", () => {
  assert.deepEqual(groutDerivedFields({ ...GROUT_DEFAULTS }), { per: 512, note: "12×24×3/8″ @ 1/8″ · 25 lb" });
});

test("groutDerivedFields: any invalid/incomplete param → null (keep the last good per + note)", () => {
  for (const key of GROUT_PARAM_KEYS) {
    for (const bad of [0, -1, NaN, undefined]) {
      assert.equal(groutDerivedFields({ ...GROUT_DEFAULTS, [key]: bad }), null, `${key}=${bad}`);
    }
  }
});

test("groutDerivedFields: small rates keep two decimals and never floor to per=0", () => {
  // 1 lb sample bag on the default tile → rate ≈ 20.5 … use a mosaic where Math.round used to bite
  const mosaic = { tileL: 1, tileW: 1, tileT: 0.25, joint: 0.125, bagLbs: 1 };
  const rate = groutCoverageSfPerBag(mosaic);
  assert.ok(rate > 0 && rate < 10, `mosaic rate ${rate} exercises the fractional branch`);
  const d = groutDerivedFields(mosaic);
  assert.ok(d && d.per > 0, "per must stay positive");
  assert.equal(d!.per, Math.round(rate * 100) / 100);   // two decimals, not floored to an integer
});

test("groutParamsEqual: structural, never by reference; absent KEYS compare as the defaults", () => {
  const a = { ...GROUT_DEFAULTS };
  assert.ok(groutParamsEqual(a, { ...GROUT_DEFAULTS }));            // equal values, distinct objects
  assert.ok(groutParamsEqual(undefined, undefined));
  assert.ok(!groutParamsEqual(a, { ...GROUT_DEFAULTS, joint: 0.25 }));
  assert.ok(groutParamsEqual({}, { ...GROUT_DEFAULTS }));           // both PRESENT: an absent key renders as its default
});

// round-3 finding 4: geometry PRESENCE is render-significant — the editor
// shows a CALCULATOR for a line with grout and a derive BUTTON for one
// without, so absent-vs-present can never compare equal (before this, a
// "derive from tile geometry…" click on a linked line whose entry has no
// geometry produced the defaults, compared equal, and never ambered the
// geometry row). Updates the pre-round-3 expectation that
// groutParamsEqual(undefined, { ...GROUT_DEFAULTS }) === true.
test("groutParamsEqual: presence quadrants — exactly one side absent is never equal", () => {
  assert.ok(groutParamsEqual({ ...GROUT_DEFAULTS }, { ...GROUT_DEFAULTS }), "both present, equal values");
  assert.ok(groutParamsEqual(undefined, undefined), "both absent");
  assert.ok(!groutParamsEqual(undefined, { ...GROUT_DEFAULTS }), "absent vs present (defaults)");
  assert.ok(!groutParamsEqual({ ...GROUT_DEFAULTS }, undefined), "present (defaults) vs absent");
  assert.ok(!groutParamsEqual({ ...GROUT_DEFAULTS }, { ...GROUT_DEFAULTS, tileL: 2 }), "both present, different values");
  // null/absent grout are the same "no geometry" state everywhere (m.grout || …)
  assert.ok(groutParamsEqual(null as any, undefined), "null and undefined are both absent");
  assert.ok(!groutParamsEqual(null as any, { ...GROUT_DEFAULTS }), "null vs present");
});

test("groutParamsEqual: a present-but-junk param compares as the BLANK the editor renders, not as the default", () => {
  // round-2 gap 5: `null ?? default` used to make a poisoned { tileL: null }
  // entry compare equal to the defaults while the editor rendered it blank —
  // the equality's invariant is "equal iff rendered identically", so both
  // sides now go through the editor's own { ...GROUT_DEFAULTS, ...grout }
  // merge, where null/0/NaN survive the spread and render blank (compare 0)
  for (const junk of [null, 0, NaN, "" as any]) {
    assert.ok(!groutParamsEqual({ ...GROUT_DEFAULTS, tileL: junk }, { ...GROUT_DEFAULTS }), `tileL=${junk} vs defaults`);
    assert.ok(!groutParamsEqual({ ...GROUT_DEFAULTS, tileL: junk }, undefined), `tileL=${junk} vs absent`);   // (also a presence mismatch since round-3 finding 4)
  }
  // two identically-poisoned objects render identically → equal
  assert.ok(groutParamsEqual({ tileL: null }, { tileL: 0 }));
  // numeric strings render as their number (the input coerces) → equal to it
  assert.ok(groutParamsEqual({ ...GROUT_DEFAULTS, tileL: "12" as any }, { ...GROUT_DEFAULTS }));
});

// ── the calculator's render gate (round-2 Defect A) ─────────────────────────

test("showsGroutCalc: a grout-kind area OR linear line WITH geometry renders the calculator", () => {
  const withG = { name: "Grout", kind: "grout", basis: "area", grout: { ...GROUT_DEFAULTS } };
  assert.equal(showsGroutCalc(withG), true);
  assert.equal(showsGroutCalc({ ...withG, grout: undefined }), false);       // geometry-less: never a defaults-backfilled calculator
  // linear = tile base. It used to be refused, which left base grout on a hand-typed
  // rate with no way to derive it — the one line whose rate nobody can eyeball.
  assert.equal(showsGroutCalc({ ...withG, basis: "linear" }), true);
  assert.equal(showsGroutCalc({ ...withG, basis: "linear", grout: undefined }), false);
  assert.equal(showsGroutCalc({ ...withG, basis: "count" }), false);         // an EA line has no face to grout
  assert.equal(showsGroutCalc({ ...withG, basis: "seam_lf" }), false);
  assert.equal(showsGroutCalc({ name: "Adhesive", basis: "area", grout: { ...GROUT_DEFAULTS } }), false);   // not grout-kind
  assert.equal(showsGroutCalc({ name: "Grout", basis: "area", grout: { ...GROUT_DEFAULTS } }), true);       // name-classified counts too
});

// ── tile base: the field formula, fed the base piece, divided by face SF per LF ──

test("groutDerivedFields: a linear line derives LF/bag from the CONDITION's height", () => {
  // 6″ base, 6″-wide pieces, 3/8″ thick, 1/8″ joint, 25 lb. The piece IS the tile:
  // 6×6 → 192 sf/bag, and a 6″ base is 0.5 SF of face per LF → 384 lf/bag.
  const g = { ...GROUT_DEFAULTS, tileW: 6, tileT: 0.375, joint: 0.125, bagLbs: 25 };
  const d = groutDerivedFields(g, "linear", 0.5);
  assert.equal(d!.per, 384);
  assert.equal(d!.note, '6″H × 6″W pc × 3/8″ @ 1/8″ · 25 lb');
  // the same geometry read as FIELD tile is a different (and wrong-for-base) number
  assert.notEqual(groutDerivedFields(g, "area", 0.5)!.per, d!.per);
});

test("groutDerivedFields: piece WIDTH is the parent dimension, and getting it wrong moves the buy", () => {
  // 6″ base ripped from a 12×24: the piece is 6H × 24W. Read 12 there — the parent's
  // OTHER dimension — and coverage falls 615 → 512, a 20% over-order. Against a 6×6
  // catalog cove it is 60%. Width is not a detail on this line, it is the line.
  const at = (w: number) => groutDerivedFields({ ...GROUT_DEFAULTS, tileW: w, tileT: 0.375, joint: 0.125, bagLbs: 25 }, "linear", 0.5)!.per;
  assert.equal(at(24), 615);   // 6H × 24W — field-cut from a 12×24, ripped across the 12
  assert.equal(at(12), 512);   // the same tile read the wrong way round
  assert.equal(at(6), 384);    // a 6×6 catalog cove piece
});

test("groutDerivedFields: a linear line with no condition height is NOT figurable", () => {
  const g = { ...GROUT_DEFAULTS, tileW: 6 };
  assert.equal(groutDerivedFields(g, "linear", 0), null);
  assert.equal(groutDerivedFields(g, "linear"), null);
  assert.equal(groutDerivedFields(g, "linear", -1), null);
  // ...and null is the "keep the last good per + note" contract — never a rate of 0
  assert.notEqual(groutDerivedFields(g, "area"), null);
});

test("baseGroutParams: the piece's long dimension is derived from height, never stored", () => {
  const g = { ...GROUT_DEFAULTS, tileL: 99, tileW: 6 };
  assert.equal(baseGroutParams(g, 0.5).tileL, 6);      // 0.5 ft → 6″, overriding whatever tileL held
  assert.equal(baseGroutParams(g, 0).tileL, 99);       // no height → untouched (and derive returns null)
  assert.equal(baseGroutParams(g, 0.5).tileW, 6);      // width is the estimator's, never derived
});

test("showsGroutDeriveAffordance: the explicit opt-in appears exactly when the calculator is withheld for missing geometry", () => {
  const bare = { name: "Grout", kind: "grout", basis: "area" };   // what libEntryPatch's detach pushes/attaches
  assert.equal(showsGroutDeriveAffordance(bare), true);
  assert.equal(showsGroutCalc(bare), false);
  assert.equal(showsGroutDeriveAffordance({ ...bare, grout: { ...GROUT_DEFAULTS } }), false);
  assert.equal(showsGroutDeriveAffordance({ ...bare, basis: "count" }), false);
  assert.equal(showsGroutDeriveAffordance({ name: "Adhesive", basis: "area" }), false);
  // the affordance's click seeds defaults AND derives per+note in ONE commit
  const g = { ...GROUT_DEFAULTS, ...((bare as any).grout || {}) };
  assert.deepEqual({ grout: g, ...(groutDerivedFields(g) || {}) }, { grout: { ...GROUT_DEFAULTS }, per: 512, note: "12×24×3/8″ @ 1/8″ · 25 lb" });
});

test("inFrac/groutNote: drawing-style fractions, decimal fallback off the 1/32″ grid", () => {
  assert.equal(inFrac(0.375), "3/8");
  assert.equal(inFrac(1.25), "1 1/4");
  assert.equal(inFrac(0.03125), "1/32");
  assert.equal(inFrac(0.33), "0.33");
  assert.equal(groutNote({ tileL: 2, tileW: 2, tileT: 0.25, joint: 0.0625, bagLbs: 25 }), "2×2×1/4″ @ 1/16″ · 25 lb");
});

// ── the stale-rate guard: a base line's fourth input lives off the row ────────

test("groutRateStale: a rate derived at one base height is flagged on another", () => {
  const g = { ...GROUT_DEFAULTS, tileW: 6, tileT: 0.375, joint: 0.125, bagLbs: 25 };
  const at6 = groutDerivedFields(g, "linear", 0.5)!;          // 6" base → 384 lf/bag
  const line = { name: "Grout", kind: "grout", basis: "linear", grout: g, per: at6.per };
  assert.equal(groutRateStale(line, 0.5), false, "derived for this height — clean");
  assert.equal(groutRateStale(line, 0.3333), true, "a 4\" base does not get a 6\"-base rate");
  // no height at all: not figurable, yet the line carries a rate → flag it
  assert.equal(groutRateStale(line, 0), true);
  assert.equal(groutRateStale({ ...line, per: 0 }, 0), false, "no rate to contradict");
});

test("groutRateStale: area lines and non-grout lines can never go stale this way", () => {
  const g = { ...GROUT_DEFAULTS };
  assert.equal(groutRateStale({ name: "Grout", kind: "grout", basis: "area", grout: g, per: 512 }, 0), false);
  assert.equal(groutRateStale({ name: "Mortar", kind: "mortar", basis: "linear", grout: g, per: 99 }, 0.5), false);
  assert.equal(groutRateStale({ name: "Grout", kind: "grout", basis: "linear", per: 99 }, 0.5), false, "no geometry, nothing to contradict");
});

// ── multi-course base: where the single-course identity stops holding ─────────

test("baseGroutParams: a SHORTER stated piece is honoured; at-or-above the base height derives", () => {
  const g = (tileL?: number) => ({ ...GROUT_DEFAULTS, tileW: 2, ...(tileL != null ? { tileL } : {}) });
  assert.equal(baseGroutParams(g(2), 0.5).tileL, 2);      // 2" chip in a 6" band → multi-course
  assert.equal(baseGroutParams(g(6), 0.5).tileL, 6);      // exactly the base height → one course
  assert.equal(baseGroutParams(g(99), 0.5).tileL, 6);     // taller than the base → one course
  assert.equal(baseGroutParams(g(), 0.5).tileL, 6);       // unset → derived
});

test("groutDerivedFields: a 6\" band of 2×2 mosaic is three courses, not one 6×2 piece", () => {
  const chip = { ...GROUT_DEFAULTS, tileW: 2, tileT: 0.25, joint: 0.25, bagLbs: 25 };
  const asCourses = groutDerivedFields({ ...chip, tileL: 2 }, "linear", 0.5)!.per;
  const asOnePiece = groutDerivedFields({ ...chip, tileL: 6 }, "linear", 0.5)!.per;
  assert.ok(Math.abs(asCourses - 96) < 2, `three courses → ${asCourses}, expected ≈96`);
  assert.ok(Math.abs(asOnePiece - 144) < 3, `one piece → ${asOnePiece}, expected ≈144`);
  assert.ok(asCourses < asOnePiece, "missing the interior horizontal joints under-buys");
});

test("baseCourses: 1 unless a shorter piece is stated", () => {
  assert.equal(baseCourses({ ...GROUT_DEFAULTS, tileL: 2 }, 0.5), 3);
  assert.equal(baseCourses({ ...GROUT_DEFAULTS, tileL: 6 }, 0.5), 1);
  assert.equal(baseCourses({ ...GROUT_DEFAULTS, tileL: 99 }, 0.5), 1);
  assert.equal(baseCourses({ ...GROUT_DEFAULTS }, 0), 1, "no height → no course claim");
});

// ── stick goods: an edge/cap profile is bought by the stock LENGTH ────────────

test("materialKind: edge/cap profiles classify as trim, and never eat an adhesive", () => {
  assert.equal(materialKind({ name: "Top cap profile" }), "trim");
  assert.equal(materialKind({ name: "Tile edge trim" }), "trim");
  assert.equal(materialKind({ name: "Stair nosing" }), "trim");
  assert.equal(materialKind({ name: "SCHIENE edge" }), "trim");
  // adhesive is matched FIRST, so a trim-adhesive stays an adhesive
  assert.equal(materialKind({ name: "Trim adhesive" }), "adhesive");
  assert.equal(materialKind({ name: "Cove base adhesive" }), "adhesive");
  // an explicit kind still wins
  assert.equal(materialKind({ name: "Top cap profile", kind: "transition" }), "transition");
});

test("trim presets are LF-per-stick, with the metric stock lengths exact", () => {
  const by = Object.fromEntries((MATERIAL_PRESETS as any).trim.map((p: any) => [p.label, p.per]));
  // 2.5 m = 8.202 ft, not 8 — a stick short on every order is the failure this prevents
  assert.ok(Math.abs(by["2.5 m stick (8′ 2-1/2″)"] - 2.5 / 0.3048) < 0.001);
  assert.ok(Math.abs(by["3 m stick (9′ 10″)"] - 3 / 0.3048) < 0.001);
  assert.ok(Math.abs(by["1.5 m stick (4′ 11″)"] - 1.5 / 0.3048) < 0.001);
  // 500 LF of cap off 2.5 m sticks
  assert.equal(Math.ceil(500 / by["2.5 m stick (8′ 2-1/2″)"]), 61);
  // a grout line must NOT pick up the trim calculator
  assert.equal(showsGroutCalc({ name: "Top cap profile", basis: "linear", grout: { ...GROUT_DEFAULTS } }), false);
});

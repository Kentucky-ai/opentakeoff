import { test } from "node:test";
import assert from "node:assert/strict";
// coverage.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { materialKind, MATERIAL_PRESETS, GROUT_DEFAULTS, GROUT_PARAM_KEYS, groutCoverageSfPerBag, groutDerivedFields, groutParamsEqual, groutNote, inFrac, showsGroutCalc, showsGroutDeriveAffordance } from "../src/lib/coverage.js";

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

test("showsGroutCalc: only a grout-kind, area-basis line WITH geometry renders the calculator", () => {
  const withG = { name: "Grout", kind: "grout", basis: "area", grout: { ...GROUT_DEFAULTS } };
  assert.equal(showsGroutCalc(withG), true);
  assert.equal(showsGroutCalc({ ...withG, grout: undefined }), false);       // geometry-less: never a defaults-backfilled calculator
  assert.equal(showsGroutCalc({ ...withG, basis: "linear" }), false);
  assert.equal(showsGroutCalc({ name: "Adhesive", basis: "area", grout: { ...GROUT_DEFAULTS } }), false);   // not grout-kind
  assert.equal(showsGroutCalc({ name: "Grout", basis: "area", grout: { ...GROUT_DEFAULTS } }), true);       // name-classified counts too
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

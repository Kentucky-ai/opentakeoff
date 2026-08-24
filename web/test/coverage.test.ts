import { test } from "node:test";
import assert from "node:assert/strict";
// coverage.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { materialKind, MATERIAL_PRESETS, findPresetById, findPresetByNote, GROUT_DEFAULTS, GROUT_PARAM_KEYS, groutCoverageSfPerBag, groutDerivedFields, groutParamsEqual, groutNote, groutDisplayNote, coverageRateForDisplay, coverageRateToCanonical, inFrac, showsGroutCalc, showsGroutDeriveAffordance } from "../src/lib/coverage.js";

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

// ── preset_id stability ──────────────────────────────────────────────────────
// Presets carry a stable `preset_id` so the UI matches locale-independently.
// Legacy materials that only have `note` (no `preset_id`) still match by label.

test("presets: every preset carries a stable, non-empty preset_id", () => {
  for (const [kind, list] of Object.entries(MATERIAL_PRESETS)) {
    for (const p of list as any[]) {
      assert.ok(typeof p.preset_id === "string" && p.preset_id.length > 0, `${kind}: ${p.label} missing preset_id`);
    }
  }
});

test("presets: preset_ids are unique across all kinds (no collision between adhesive and mortar)", () => {
  const ids = new Set<string>();
  for (const list of Object.values(MATERIAL_PRESETS)) {
    for (const p of list as any[]) {
      assert.ok(!ids.has(p.preset_id), `duplicate preset_id: ${p.preset_id}`);
      ids.add(p.preset_id);
    }
  }
});

test("findPresetById: returns the preset matching the id", () => {
  const p = findPresetById("adhesive_1_16_sq");
  assert.ok(p, "found");
  assert.equal(p!.preset_id, "adhesive_1_16_sq");
  assert.equal(p!.per, 150);
});

test("findPresetById: returns undefined for unknown ids and empty/null", () => {
  assert.equal(findPresetById("nonexistent"), undefined);
  assert.equal(findPresetById(""), undefined);
  assert.equal(findPresetById(null as any), undefined);
  assert.equal(findPresetById(undefined as any), undefined);
});

test("findPresetById: finds presets across both kinds", () => {
  assert.equal(findPresetById("adhesive_1_2_v")?.per, 40);
  assert.equal(findPresetById("mortar_3_4_u")?.per, 30);
});

// ── findPresetByNote: cross-locale legacy matching ─────────────────────────
// Legacy materials (no preset_id) store the label that was active when the
// user picked the preset.  After a locale switch, the current label differs,
// so findPresetByNote checks every supported locale's translation.

test("findPresetByNote: matches the current locale's label", () => {
  // The English preset labels are the test-time locale
  const p = findPresetByNote("1/16″×1/16″×1/16″ sq");
  assert.ok(p, "found by English label");
  assert.equal(p!.preset_id, "adhesive_1_16_sq");
  assert.equal(p!.per, 150);
});

test("findPresetByNote: returns undefined for unknown notes and empty/null", () => {
  assert.equal(findPresetByNote("nonexistent"), undefined);
  assert.equal(findPresetByNote(""), undefined);
  assert.equal(findPresetByNote(null as any), undefined);
  assert.equal(findPresetByNote(undefined as any), undefined);
});

test("findPresetByNote: is case-insensitive and trims whitespace", () => {
  const p = findPresetByNote("  1/16″×1/16″×1/16″ SQ  ");
  assert.ok(p, "found despite case and whitespace");
  assert.equal(p!.preset_id, "adhesive_1_16_sq");
});

// ── groutDerivedFields: the derive-only-when-valid rule ─────────────────────
// (adversarial review findings 5/8: a cleared tile dimension used to commit
// per=0 and a "0×24×…" note, silently zeroing grout in every export)

test("groutDerivedFields: valid geometry → rounded per (note is derived at render, not stored)", () => {
  const result = groutDerivedFields({ ...GROUT_DEFAULTS });
  assert.deepEqual(result, { per: 512 });
  // The note is display-only — groutDisplayNote derives it from the geometry
  assert.equal(groutDisplayNote({ grout: { ...GROUT_DEFAULTS } }, "imperial"), "12×24×3/8″ @ 1/8″ · 25 lb");
});

test("grout metric display converts lengths at the UI edge and keeps canonical math", () => {
  const metric = { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125, bagLbs: 25 };
  assert.equal(groutNote(metric, "metric"), "305×610×10 mm @ 3.2 mm · 25 lb");
  // per is always canonical (SF/bag) regardless of display units
  assert.equal(groutDerivedFields(metric)?.per, groutDerivedFields({ ...GROUT_DEFAULTS })?.per);
});

test("groutDisplayNote: switches between imperial and metric from the same canonical grout", () => {
  const m = { grout: { tileL: 12, tileW: 24, tileT: 0.375, joint: 0.125, bagLbs: 25 } };
  assert.equal(groutDisplayNote(m, "imperial"), "12×24×3/8″ @ 1/8″ · 25 lb");
  assert.equal(groutDisplayNote(m, "metric"), "305×610×10 mm @ 3.2 mm · 25 lb");
  // No grout → falls back to m.note
  assert.equal(groutDisplayNote({ note: "custom note" }, "metric"), "custom note");
  assert.equal(groutDisplayNote({}, "imperial"), "");
});

test("groutDerivedFields does NOT persist a note — only per is stored", () => {
  const result = groutDerivedFields({ ...GROUT_DEFAULTS });
  assert.ok(result && "per" in result, "has per");
  assert.ok(!("note" in (result || {})), "must not contain note");
});

test("material coverage rates round-trip between canonical SF/LF and metric m²/m", () => {
  for (const [per, basis, shown] of [[100, "area", 9.290304], [25, "linear", 7.62], [25, "seam_lf", 7.62], [4, "count", 4]] as const) {
    assert.ok(Math.abs(coverageRateForDisplay(per, basis, "metric") - shown) < 1e-9);
    assert.ok(Math.abs(coverageRateToCanonical(shown, basis, "metric") - per) < 1e-9);
  }
});

test("groutDerivedFields: any invalid/incomplete param → null (keep the last good per + note)", () => {
  for (const key of GROUT_PARAM_KEYS) {
    for (const bad of [0, -1, NaN, undefined]) {
      assert.equal(groutDerivedFields({ ...GROUT_DEFAULTS, [key]: bad }), null, `${key}=${bad}`);
    }
  }
});

test("groutDerivedFields: boundary values at max joint (0.5in / 12.7mm) produce valid per", () => {
  // Imperial max: joint = 0.5 in
  const maxImp = { ...GROUT_DEFAULTS, joint: 0.5 };
  const rImp = groutDerivedFields(maxImp);
  assert.ok(rImp && rImp.per > 0, `imperial max joint ${rImp?.per}`);
  // Metric max: 12.7 mm ≈ 0.5 in
  const maxMet = { ...GROUT_DEFAULTS, joint: 12.7 / 25.4 };
  const rMet = groutDerivedFields(maxMet);
  assert.ok(rMet && rMet.per > 0, `metric max joint ${rMet?.per}`);
  // Both should produce the same canonical per (same geometry)
  assert.equal(rImp!.per, rMet!.per);
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
  // the affordance's click seeds defaults AND derives per in ONE commit
  const g = { ...GROUT_DEFAULTS, ...((bare as any).grout || {}) };
  assert.deepEqual({ grout: g, ...(groutDerivedFields(g) || {}) }, { grout: { ...GROUT_DEFAULTS }, per: 512 });
});

test("inFrac/groutNote: drawing-style fractions, decimal fallback off the 1/32″ grid", () => {
  assert.equal(inFrac(0.375), "3/8");
  assert.equal(inFrac(1.25), "1 1/4");
  assert.equal(inFrac(0.03125), "1/32");
  assert.equal(inFrac(0.33), "0.33");
  assert.equal(groutNote({ tileL: 2, tileW: 2, tileT: 0.25, joint: 0.0625, bagLbs: 25 }), "2×2×1/4″ @ 1/16″ · 25 lb");
});

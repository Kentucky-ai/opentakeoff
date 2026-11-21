import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRevisionLedger, revisionLedgerCsv, subtractQty, type LedgerPair, type LedgerShape } from "../src/lib/revisionLedger.ts";
import type { ChangedRegion } from "../src/lib/revisionDiff.ts";

// Sheets are 1000 x 1000 px so normalized verts read as px / 1000.
const W = 1000;
const side = (key: string) => ({ key, width: W, height: W, upp: 0.1 });
const region = (id: string, x0: number, y0: number, x1: number, y1: number, type: ChangedRegion["type"] = "modified"): ChangedRegion => ({
  id, type, bounds: [x0, y0, x1, y1], hull: [[x0 - 4, y0 - 4], [x1 + 4, y0 - 4], [x1 + 4, y1 + 4], [x0 - 4, y1 + 4]], segmentCount: 6,
  segments: [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]],
});
const pair = (regions: ChangedRegion[], over: Partial<LedgerPair> = {}): LedgerPair => ({
  sheet_number: "A101", base: side("old.pdf"), revised: side("new.pdf"),
  alignment: { dx: 0, dy: 0, confidence: 0.9, method: "auto_frame" }, diff_method: "vector", comparable: true,
  regions, text_changes: [], ...over,
});
const conditions = [{ id: "c-cpt", finish_tag: "CPT-1" }, { id: "c-vct", finish_tag: "VCT-1" }, { id: "c-ea", finish_tag: "FD" }];
const rect = (id: string, sheet: string, cond: string, x0: number, y0: number, x1: number, y1: number, origin: object = {}): LedgerShape & { computed: object } => ({
  id, sheet_id: sheet, condition_id: cond, measure_role: "floor_area",
  verts_norm: [[x0 / W, y0 / W], [x1 / W, y0 / W], [x1 / W, y1 / W], [x0 / W, y1 / W]],
  computed: { area_sf: ((x1 - x0) * (y1 - y0)) / 100, perimeter_lf: (2 * (x1 - x0 + y1 - y0)) / 10 },
  origin,
});
const count = (id: string, sheet: string, x: number, y: number): LedgerShape & { computed: object } => ({
  id, sheet_id: sheet, condition_id: "c-ea", measure_role: "count", verts_norm: [[x / W, y / W]], computed: { count: 1 },
});
const build = (pairs: LedgerPair[], shapes: LedgerShape[], extra: object = {}) =>
  buildRevisionLedger({ pairs, added_sheets: [], removed_sheets: [], unpaired: [], conditions, shapes, ...extra });

test("before the revised sheet is measured a touched shape is EXPOSURE, never a delta", () => {
  const l = build([pair([region("crg-1", 150, 150, 180, 180)])], [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("far", "old.pdf", "c-vct", 600, 600, 800, 800)]);
  const e = l.entries[0];
  assert.equal(e.status, "not_carried");
  assert.equal(e.delta, null);
  assert.deepEqual(e.before.shape_ids, ["a"]);
  assert.deepEqual(e.exposure, [{ condition: "CPT-1", condition_id: "c-cpt", floor_sf: 400 }]);
  assert.deepEqual(e.review, ["takeoff_not_carried"]);
  assert.equal(l.sheets[0].after, null);
  assert.deepEqual(l.totals.exposure, [{ condition: "CPT-1", condition_id: "c-cpt", floor_sf: 400 }]);
  assert.deepEqual(l.totals.delta, []);
});

test("carried forward unchanged is pending until an agent checks it or a person approves it", () => {
  const shapes = [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("a2", "new.pdf", "c-cpt", 100, 100, 300, 300, { reviewed: false, flagged_for_revision: true })];
  const p = [pair([region("crg-1", 150, 150, 180, 180)])];
  assert.equal(build(p, shapes).entries[0].status, "pending");
  assert.equal(build(p, shapes).entries[0].delta, null);
  const checked = build(p, shapes, { agent_checked_shape_ids: ["a2"] }).entries[0];
  assert.equal(checked.status, "agent_checked");
  assert.deepEqual(checked.delta, []);
  assert.deepEqual(checked.review, ["agent_checked_unapproved"]);
  const approved = build(p, [shapes[0], rect("a2", "new.pdf", "c-cpt", 100, 100, 300, 300, { reviewed: true })]).entries[0];
  assert.equal(approved.status, "confirmed_unchanged");
  assert.deepEqual(approved.review, []);
});

test("a remeasured room states its delta, attributed to the region that caused it", () => {
  const l = build([pair([region("crg-1", 290, 150, 340, 250)])], [
    rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("b", "old.pdf", "c-vct", 600, 600, 800, 800),
    rect("a2", "new.pdf", "c-cpt", 100, 100, 350, 300), rect("b2", "new.pdf", "c-vct", 600, 600, 800, 800, { reviewed: true }),
  ]);
  const e = l.entries.find((x) => x.id === "A101/crg-1")!;
  assert.equal(e.status, "remeasured");
  assert.deepEqual(e.delta, [{ condition: "CPT-1", condition_id: "c-cpt", floor_sf: 100 }]);
  assert.deepEqual(e.review, ["revised_takeoff_unapproved"]);
  const s = l.sheets[0];
  assert.deepEqual(s.delta, [{ condition: "CPT-1", condition_id: "c-cpt", floor_sf: 100 }]);
  assert.deepEqual(s.attributed, s.delta);
  assert.deepEqual(s.unattributed, []);
  assert.deepEqual(s.review, []);
});

test("a quantity that moved where the drawing did not change is unattributed, with the shapes named", () => {
  const l = build([pair([region("crg-1", 150, 150, 180, 180)])], [
    rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("b", "old.pdf", "c-vct", 600, 600, 800, 800),
    rect("a2", "new.pdf", "c-cpt", 100, 100, 300, 300, { reviewed: true }), rect("b2", "new.pdf", "c-vct", 600, 600, 900, 800),
  ]);
  const s = l.sheets[0];
  assert.deepEqual(s.unattributed, [{ condition: "VCT-1", condition_id: "c-vct", floor_sf: 200 }]);
  assert.deepEqual(s.attributed, []);
  assert.deepEqual(s.unattributed_shape_ids, { base: ["b"], revised: ["b2"] });
  assert.ok(s.review.includes("quantity_changed_outside_drawing_change"));
  // delta = attributed + unattributed, always
  assert.deepEqual(subtractQty(s.delta!, s.attributed!), s.unattributed);
});

test("added, removed and outside-takeoff changes; counts are touched as points", () => {
  const l = build([pair([region("crg-add", 500, 100, 560, 160, "added"), region("crg-gone", 100, 500, 160, 560, "removed"), region("crg-title", 900, 900, 980, 980)])], [
    count("d1", "old.pdf", 105, 530), count("d-keep", "old.pdf", 300, 300),
    count("d-keep2", "new.pdf", 300, 300), count("d-new", "new.pdf", 505, 130),
  ]);
  const by = Object.fromEntries(l.entries.map((e) => [e.id, e]));
  assert.equal(by["A101/crg-add"].status, "added");
  assert.deepEqual(by["A101/crg-add"].delta, [{ condition: "FD", condition_id: "c-ea", ea: 1 }]);
  assert.equal(by["A101/crg-gone"].status, "removed");
  assert.deepEqual(by["A101/crg-gone"].delta, [{ condition: "FD", condition_id: "c-ea", ea: -1 }]);
  assert.deepEqual(by["A101/crg-gone"].review, ["confirm_scope_removed"]);
  assert.equal(by["A101/crg-title"].status, "outside_takeoff");
  assert.deepEqual(by["A101/crg-title"].review, []);
  // review-needing entries sort first, outside-takeoff last
  assert.equal(l.entries[l.entries.length - 1].id, "A101/crg-title");
  assert.deepEqual(l.sheets[0].unattributed, []);
});

test("text changes ride the region beside them; loose ones become their own entry and flag a dimension", () => {
  const l = build([pair([region("crg-1", 150, 150, 180, 180)], {
    text_changes: [
      { type: "changed", before: "CPT-1", after: "LVT-2", at: [160, 160] },
      { type: "changed", before: `12'-0"`, after: `14'-0"`, at: [700, 700] },
    ],
  })], [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("b", "old.pdf", "c-vct", 600, 600, 800, 800)]);
  const line = l.entries.find((e) => e.id === "A101/crg-1")!;
  assert.equal(line.text_changes[0].after, "LVT-2");
  assert.ok(line.review.includes("text_changed"));
  const text = l.entries.find((e) => e.kind === "text")!;
  assert.deepEqual(text.before.shape_ids, ["b"]);
  assert.ok(text.review.includes("dimension_text_changed"));
});

test("sheet-level cautions reach the entries that touch takeoff; added and removed sheets are their own entries", () => {
  const l = buildRevisionLedger({
    pairs: [pair([region("crg-1", 150, 150, 180, 180)], {
      alignment: { dx: 0, dy: 0, confidence: 0.1, method: "identity" },
      revised: { key: "new.pdf", width: W, height: W, upp: 0.2 },
    })],
    added_sheets: [{ key: "new.pdf#2", sheet_number: "A102" }],
    removed_sheets: [{ key: "old.pdf#3", sheet_number: "A103" }],
    unpaired: [{ sheet_number: null, base: ["old.pdf#4"], revised: [], reason: "no title-block sheet number read" }],
    conditions,
    shapes: [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("gone", "old.pdf#3", "c-vct", 0, 0, 100, 100)],
  });
  const e = l.entries.find((x) => x.id === "A101/crg-1")!;
  assert.ok(e.review.includes("alignment_low_confidence") && e.review.includes("scale_changed"));
  const removed = l.entries.find((x) => x.kind === "sheet_removed")!;
  assert.equal(removed.status, "removed");
  assert.deepEqual(removed.delta, [{ condition: "VCT-1", condition_id: "c-vct", floor_sf: -100 }]);
  assert.equal(l.entries.find((x) => x.kind === "sheet_added")!.status, "unmeasured");
  assert.equal(l.unpaired.length, 1);
  assert.equal(l.counts.by_status.removed, 1);
});

test("a one-segment sub-2px difference is counted as a speck, not raised as a change", () => {
  const speck: ChangedRegion = { id: "crg-9", type: "removed", bounds: [200, 200, 200, 201], hull: [[196, 196], [204, 196], [204, 205], [196, 205]], segmentCount: 1, segments: [[200, 200, 200, 201]] };
  const l = build([pair([speck])], [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300)]);
  assert.equal(l.entries.length, 0);
  assert.equal(l.sheets[0].specks_ignored, 1);
});

test("revisionLedgerCsv: one row per entry per condition; an unmeasured delta is blank, not zero", () => {
  const open = build([pair([region("crg-1", 150, 150, 180, 180)])], [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300)]);
  const rows = revisionLedgerCsv(open).trim().split("\n");
  assert.equal(rows[0].split(",")[0], "entry");
  assert.equal(rows[1], "A101/crg-1,A101,linework,modified,not_carried,takeoff_not_carried,CPT-1,400,,,0,,,0,,,150 150 180 180,");
  const done = build([pair([region("crg-1", 290, 150, 340, 250)])], [rect("a", "old.pdf", "c-cpt", 100, 100, 300, 300), rect("a2", "new.pdf", "c-cpt", 100, 100, 350, 300)]);
  assert.match(revisionLedgerCsv(done), /A101\/crg-1,A101,linework,modified,remeasured,revised_takeoff_unapproved,CPT-1,400,500,100,/);
});

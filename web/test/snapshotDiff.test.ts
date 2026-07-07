// Snapshot diff engine (PR-6): quantity-level comparison of two annotations
// payloads. The invariants under test:
//   - self-compare is identical: every status "unchanged", all deltas 0,
//     zero-shape conditions included (never fabricated into added/removed);
//   - added/removed conditions carry deltas = ±their values (not zero-filled);
//   - a deleted-and-recreated condition (fresh uid, same finish_tag) matches
//     via the tag fallback and diffs as "unchanged";
//   - waste-only edits move total_sf_net alone; multiplier edits move the
//     condition row (conditionTotals applies ×N) while by_sheet base rows
//     stay equal and that sheet is dropped;
//   - by_sheet catches a shape moved between sheets even when condition
//     totals reconcile — identical must go false;
//   - missing/empty payload arrays are tolerated (diff against {}).
import { test } from "node:test";
import assert from "node:assert/strict";
// snapshotDiff.js / totals.js are plain JS (allowJs); tsx resolves them from .ts tests.
import { diffSnapshots } from "../src/lib/snapshotDiff.js";
import { round2 } from "../src/lib/totals.js";
import { conditions as fixtureConditions, shapes as fixtureShapes } from "./fixtures/report.fixture.ts";

const COND_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea", "total_sf", "total_sf_net"];

const payload = (conditions: any[], shapes: any[]) => ({ conditions, shapes });
const floorShape = (id: string, condition_id: string, sheet_id: string, area_sf: number) =>
  ({ id, condition_id, sheet_id, measure_role: "floor_area", computed: { area_sf } });

// ── 1. self-compare ──────────────────────────────────────────────────────────

test("self-compare is identical: every status unchanged, all deltas zero", () => {
  const P = payload(fixtureConditions, fixtureShapes);
  const d = diffSnapshots(P, P);
  assert.equal(d.identical, true);
  assert.equal(d.by_sheet.length, 0);                       // unchanged sheets are dropped
  assert.equal(d.conditions.length, fixtureConditions.length);
  for (const e of d.conditions) {
    assert.equal(e.status, "unchanged");
    for (const f of COND_FIELDS) assert.equal(e.deltas[f], 0, `${e.key}.${f}`);
    assert.ok(e.a && e.b);
  }
  // the zero-shape condition still exists on both sides — "unchanged", never
  // fabricated into an added/removed pair
  const empty = d.conditions.find((e: any) => e.key === "empty")!;
  assert.equal(empty.status, "unchanged");
  assert.equal(empty.a.shape_count, 0);
});

// ── 2. added / removed ───────────────────────────────────────────────────────

test("added and removed conditions carry deltas = ±their values", () => {
  const x = { id: "x", finish_tag: "X" };
  const A = payload([x, { id: "y", finish_tag: "Y" }], [
    floorShape("s1", "x", "plan", 100),
    floorShape("s2", "y", "plan", 50),
  ]);
  const B = payload([x, { id: "z", finish_tag: "Z" }], [
    floorShape("s1", "x", "plan", 100),
    floorShape("s3", "z", "plan", 25),
  ]);
  const d = diffSnapshots(A, B);
  assert.equal(d.identical, false);
  // B order first (x, z), removed-A appended (y)
  assert.deepEqual(d.conditions.map((e: any) => [e.key, e.status]), [
    ["x", "unchanged"], ["z", "added"], ["y", "removed"],
  ]);
  const added = d.conditions[1];
  assert.equal(added.a, null);
  assert.equal(added.deltas.floor_sf, 25);                  // = b's values, not 0
  assert.equal(added.deltas.total_sf, 25);
  assert.equal(added.deltas.total_sf_net, 25);
  const removed = d.conditions[2];
  assert.equal(removed.b, null);
  assert.equal(removed.finish_tag, "Y");                    // falls back to a's tag
  assert.equal(removed.deltas.floor_sf, -50);               // = −a's values
  assert.equal(removed.deltas.total_sf, -50);
});

// ── 3. recreated condition (uid churn) ───────────────────────────────────────

test("deleted-and-recreated condition matches by finish_tag and diffs unchanged", () => {
  const A = payload([{ id: "old1", finish_tag: "CT-1" }],
    [floorShape("s1", "old1", "plan", 123.45)]);
  const B = payload([{ id: "new9", finish_tag: "CT-1" }],
    [floorShape("s99", "new9", "plan", 123.45)]);           // fresh shape uid too
  const d = diffSnapshots(A, B);
  assert.equal(d.conditions.length, 1);                     // NOT remove+add
  const e = d.conditions[0];
  assert.equal(e.key, "tag:CT-1");
  assert.equal(e.status, "unchanged");
  for (const f of COND_FIELDS) assert.equal(e.deltas[f], 0);
  // the tag key carries through to by_sheet, so the sheet reconciles too
  assert.equal(d.by_sheet.length, 0);
  assert.equal(d.identical, true);
});

// ── 4. quantity change ───────────────────────────────────────────────────────

test("a shape's area change diffs as 'changed' with the exact round2 delta", () => {
  const cond = { id: "ct1", finish_tag: "CT-1" };
  const A = payload([cond], [floorShape("s1", "ct1", "plan", 100.25)]);
  const B = payload([cond], [floorShape("s1", "ct1", "plan", 133.7)]);
  const d = diffSnapshots(A, B);
  const e = d.conditions[0];
  assert.equal(e.status, "changed");
  assert.equal(e.deltas.floor_sf, round2(133.7 - 100.25));  // 33.45
  assert.equal(e.deltas.total_sf, 33.45);
  assert.equal(e.deltas.total_sf_net, 33.45);               // no waste → net moves in step
  assert.equal(d.identical, false);
  // and the sheet-level view shows where it moved
  assert.equal(d.by_sheet.length, 1);
  assert.equal(d.by_sheet[0].sheet_id, "plan");
  assert.equal(d.by_sheet[0].rows[0].status, "changed");
  assert.equal(d.by_sheet[0].rows[0].deltas.floor_sf, 33.45);
});

// ── 5. multiplier change ─────────────────────────────────────────────────────

test("multiplier 1→2 changes the condition row; base sheet rows equal → sheet dropped", () => {
  const shapes = [floorShape("s1", "c", "plan", 210.55)];
  const A = payload([{ id: "c", finish_tag: "LVT-2", multiplier: 1 }], shapes);
  const B = payload([{ id: "c", finish_tag: "LVT-2", multiplier: 2 }], shapes);
  const d = diffSnapshots(A, B);
  const e = d.conditions[0];
  assert.equal(e.status, "changed");                        // conditionTotals applies ×N
  assert.equal(e.deltas.total_sf, 210.55);                  // doubled − base
  assert.equal(e.deltas.floor_sf, 210.55);
  // by_sheet mirrors sheetTotals: BASE quantities, multiplier NOT applied —
  // identical bases mean zero deltas, so the sheet is dropped entirely
  assert.equal(d.by_sheet.length, 0);
  assert.equal(d.identical, false);                         // the condition change still counts
});

// ── 6. waste change ──────────────────────────────────────────────────────────

test("waste_pct-only edit moves total_sf_net alone — measured quantities stay equal", () => {
  const shapes = [floorShape("s1", "c", "plan", 100)];
  const A = payload([{ id: "c", finish_tag: "CT-1", waste_pct: 0 }], shapes);
  const B = payload([{ id: "c", finish_tag: "CT-1", waste_pct: 10 }], shapes);
  const d = diffSnapshots(A, B);
  const e = d.conditions[0];
  assert.equal(e.status, "changed");
  assert.equal(e.deltas.floor_sf, 0);
  assert.equal(e.deltas.total_sf, 0);
  assert.equal(e.deltas.total_sf_net, 10);                  // order quantity moved, takeoff didn't
  assert.equal(d.by_sheet.length, 0);                       // no waste at sheet level
  assert.equal(d.identical, false);
});

// ── 7. by_sheet: shape moved between sheets ──────────────────────────────────

test("a shape moved to another sheet: condition unchanged, by_sheet shows −/+ pair", () => {
  const cond = { id: "c", finish_tag: "CT-1" };
  const A = payload([cond], [floorShape("s1", "c", "sheet1", 100)]);
  const B = payload([cond], [floorShape("s1", "c", "sheet2", 100)]);
  const d = diffSnapshots(A, B);
  assert.equal(d.conditions[0].status, "unchanged");        // totals reconcile
  assert.equal(d.identical, false);                         // ...but the takeoff moved
  // B sheets first, then A-only sheets
  assert.deepEqual(d.by_sheet.map((g: any) => g.sheet_id), ["sheet2", "sheet1"]);
  const [gained, lost] = d.by_sheet;
  assert.equal(gained.rows[0].status, "added");
  assert.equal(gained.rows[0].deltas.floor_sf, 100);
  assert.equal(lost.rows[0].status, "removed");
  assert.equal(lost.rows[0].deltas.floor_sf, -100);
});

// ── 8. missing/empty payloads ────────────────────────────────────────────────

test("missing payload arrays are tolerated — diff against {}", () => {
  const P = payload([{ id: "c", finish_tag: "CT-1" }], [floorShape("s1", "c", "plan", 100)]);

  const empty = diffSnapshots({}, {});
  assert.equal(empty.identical, true);
  assert.deepEqual(empty.conditions, []);
  assert.deepEqual(empty.by_sheet, []);

  const allAdded = diffSnapshots({}, P);
  assert.equal(allAdded.identical, false);
  assert.equal(allAdded.conditions[0].status, "added");
  assert.equal(allAdded.conditions[0].deltas.floor_sf, 100);
  assert.equal(allAdded.by_sheet[0].rows[0].status, "added");

  const allRemoved = diffSnapshots(P, {});
  assert.equal(allRemoved.conditions[0].status, "removed");
  assert.equal(allRemoved.conditions[0].deltas.floor_sf, -100);
  assert.equal(allRemoved.by_sheet[0].rows[0].deltas.floor_sf, -100);
});

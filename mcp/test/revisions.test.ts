import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { Session } from "../src/session.ts";

const DEMO = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

test("compare_sheets compares two sheets, computes diff and returns changed regions and stats", async () => {
  const session = new Session();
  const loaded = await session.loadPlan(DEMO);
  const sheets = loaded.sheets;
  assert.ok(sheets.length >= 2, "sample plan has at least two sheets");

  // Add a shape to sheet 1
  session.conditions.push({ id: "cnd-test", finish_tag: "CPT-TEST", description: "Carpet Test", color: "#1f3fc7" } as any);
  session.shapes.push({
    id: "shp-test",
    sheet_id: sheets[0].sheet,
    condition_id: "cnd-test",
    measure_role: "floor_area",
    verts_norm: [
      [0.2, 0.2],
      [0.3, 0.2],
      [0.3, 0.3],
      [0.2, 0.3],
    ],
    origin: { method: "manual", actor: "agent", reviewed: true },
  } as any);

  // Compare sheet 1 with sheet 1 (identical)
  const resSame = await session.compareSheets(sheets[0].sheet, sheets[0].sheet);
  assert.equal(resSame.diff_method, "vector");
  assert.deepEqual(resSame.alignment, { dx: 0, dy: 0, confidence: 1, method: "identity" });
  const extracted = await session.sheetVectors(sheets[0].sheet, { limit: 1 });
  assert.equal(resSame.stats.unchanged_segments, extracted.total, "every extracted segment matches itself");
  assert.equal(resSame.stats.removed_segments, 0);
  assert.equal(resSame.stats.added_segments, 0);
  assert.equal(resSame.flagged_shape_ids.length, 0);

  // Compare sheet 1 with sheet 2 (different sheets)
  const resDiff = await session.compareSheets(sheets[0].sheet, sheets[1].sheet);
  assert.equal(resDiff.diff_method, "vector");
  assert.ok(resDiff.stats.removed_segments > 0 || resDiff.stats.added_segments > 0);
  assert.ok(Array.isArray(resDiff.changed_regions));
  const incoming = await session.sheetVectors(sheets[1].sheet, { limit: 1 });
  assert.equal(resDiff.stats.unchanged_segments + resDiff.stats.removed_segments, extracted.total);
  assert.equal(resDiff.stats.unchanged_segments + resDiff.stats.added_segments, incoming.total);
});

test("compare_sheets reports one shared, one removed, and one added PDF segment", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "opentakeoff-revision-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  const base = pdf.addPage([300, 200]);
  const revised = pdf.addPage([300, 200]);
  for (const page of [base, revised]) {
    page.drawLine({ start: { x: 20, y: 160 }, end: { x: 40, y: 160 }, thickness: 1 });
  }
  base.drawLine({ start: { x: 80, y: 120 }, end: { x: 110, y: 120 }, thickness: 1 });
  revised.drawLine({ start: { x: 180, y: 60 }, end: { x: 215, y: 60 }, thickness: 1 });
  const file = path.join(scratch, "revision.pdf");
  await writeFile(file, await pdf.save());

  const session = new Session();
  const { sheets } = await session.loadPlan(file);
  const result = await session.compareSheets(sheets[0].sheet, sheets[1].sheet, { dx: 0, dy: 0 });
  assert.deepEqual(result.stats, { unchanged_segments: 1, removed_segments: 1, added_segments: 1 });
  assert.deepEqual(result.alignment, { dx: 0, dy: 0, confidence: 1, method: "manual" });
  assert.deepEqual(result.changed_regions.map((region) => [region.type, region.bounds]), [
    ["removed", [160, 160, 220, 160]],
    ["added", [360, 280, 430, 280]],
  ]);
});

// A real reissued sheet: Missouri OA/FMDC project T2327-01, sheet A-100 as bid
// and as reissued by Addendum 2, which added Detail 3 (bollard location plan)
// and nudged the four bollards at grid D/3. See demo/public-sheets/README.md.
const A100 = fileURLToPath(new URL("../../demo/public-sheets/mo-albany-maintenance-A-100-floor-plan.pdf", import.meta.url));
const A100_ADD2 = fileURLToPath(new URL("../../demo/public-sheets/mo-albany-maintenance-A-100-floor-plan-addendum-2.pdf", import.meta.url));
const BASE = "mo-albany-maintenance-A-100-floor-plan.pdf";
const REV = "mo-albany-maintenance-A-100-floor-plan-addendum-2.pdf";
const BOLLARD_ROWS = [882.6, 1338.3, 1395.3, 1851, 1907.9, 2363.6, 2420.6, 2876.3];

async function albany() {
  const session = new Session();
  await session.loadPlan(A100);
  await session.loadPlan(A100_ADD2, { merge: true });
  return session;
}

test("revision_delta pairs the two issues of A-100 by sheet number and finds what Addendum 2 changed", async () => {
  const session = await albany();
  const d = await session.revisionDelta({ base: BASE, revised: REV });
  assert.equal(d.schema, "opentakeoff.revision_delta.v1");
  assert.equal(d.sheets.length, 1);
  assert.equal(d.sheets[0].sheet_number, "A-100");
  assert.deepEqual(d.unpaired, []);
  // the new detail: one added region in the lower right carrying its own labels
  const detail = d.entries.find((e) => e.text_changes.some((t) => t.after === "BOLLARD LOCATION PLAN"));
  assert.ok(detail, "the added detail is one entry");
  assert.equal(detail.kind, "linework");
  assert.equal(detail.change, "added");
  assert.ok(detail.segment_count! > 1000);
  // the title block: issue date retyped, addendum noted, DRAFT stamp gone
  const text = d.entries.flatMap((e) => e.text_changes);
  assert.ok(text.some((t) => t.type === "changed" && t.before === "11/15/24" && t.after === "07/16/2025"));
  assert.ok(text.some((t) => t.type === "added" && t.after === "ADDENDUM #2"));
  assert.ok(text.some((t) => t.type === "removed" && t.before === "DRAFT"));
  // two PDF writers chunk the same lines differently; that is not reported
  assert.ok(!text.some((t) => /International Building Code/.test(`${t.before ?? ""}${t.after ?? ""}`)));
  // nothing is measured yet, so nothing needs review and nothing is a delta
  assert.equal(d.counts.needs_review, 0);
  assert.ok(d.entries.every((e) => e.status === "outside_takeoff"));
  assert.deepEqual(d.totals.delta, []);
  // a set compared with itself is refused, not answered with an empty ledger
  await assert.rejects(session.revisionDelta({ base: BASE, revised: BASE }), /two issues/);
});

test("revision_delta: carry, recheck, and the ledger closes — exposure first, deltas only once measured", async () => {
  const session = await albany();
  session.setScale(BASE, { label: `3/16" = 1'-0"` });
  session.setScale(REV, { label: `3/16" = 1'-0"` });
  // the slab inside the wall faces, and the sixteen bollards at the door jambs
  session.measurePolygon(BASE, [[2294, 626.5], [3477.5, 626.5], [3477.5, 3021.5], [2294, 3021.5]], { condition: "SC-1", role: "floor_area" });
  session.placeCount(BASE, BOLLARD_ROWS.flatMap((y) => [[3462.8, y], [3520.2, y]] as [number, number][]), { condition: "BOLLARD" });

  const before = await session.revisionDelta({ base: BASE, revised: REV });
  assert.equal(before.sheets[0].after, null);
  assert.ok(before.entries.filter((e) => e.review.length).every((e) => e.status === "not_carried" && e.delta === null));
  // exposure counts each touched shape once: the slab, and only the four bollards at D/3
  assert.deepEqual(before.totals.exposure.map((q) => [q.condition, q.floor_sf ?? q.ea]), [["SC-1", 3888.18], ["BOLLARD", 4]]);

  const carried = await session.revisionDelta({ base: BASE, revised: REV, carry: true });
  assert.deepEqual(carried.carry, { carried: [{ sheet: REV, carried: 17, flagged: 5 }], skipped: [] });
  assert.equal(carried.counts.by_status.pending, before.counts.by_status.not_carried);
  const d3 = carried.entries.find((e) => e.before.quantities.some((q) => q.condition === "BOLLARD"))!;
  assert.equal(d3.status, "pending");
  assert.deepEqual(d3.after.quantities.find((q) => q.condition === "BOLLARD")!.ea, 4);
  assert.ok(d3.review.includes("recheck_takeoff") && d3.review.includes("text_changed"));
  // a second carry never stacks copies on the revised sheet
  const again = await session.revisionDelta({ base: BASE, revised: REV, carry: true });
  assert.equal(again.carry!.carried.length, 0);
  assert.equal(session.listShapes({ sheet: REV }).count, 17);

  // recheck: re-place the four moved bollards on the revised circles, mark the slab checked
  const revised = session.listShapes({ sheet: REV }).shapes;
  const moved = d3.after.shape_ids.filter((id) => revised.find((s) => s.id === id)!.measure_role === "count");
  assert.equal(moved.length, 4);
  const targets: [number, number][] = [[3461.3, 1850.1], [3520.9, 1850.1], [3461.3, 1908.6], [3520.7, 1908.5]];
  moved.forEach((id, i) => session.editShape(id, { verts: [targets[i]] }));
  session.markVerdict({ shape_id: revised.find((s) => s.measure_role === "floor_area")!.id, text: "slab outline unchanged" });

  const closed = await session.revisionDelta({ base: BASE, revised: REV });
  assert.equal(closed.counts.by_status.pending, undefined);
  assert.deepEqual(closed.totals.exposure, []);
  const d3After = closed.entries.find((e) => e.id === d3.id)!;
  assert.equal(d3After.status, "remeasured");
  assert.deepEqual(d3After.delta, [], "four bollards before, four after: moved, not added");
  assert.ok(closed.entries.filter((e) => e.status === "agent_checked").every((e) => e.review.includes("agent_checked_unapproved")));
  // the sheet reconciles and nothing moved off the changed regions
  assert.deepEqual(closed.sheets[0].delta, []);
  assert.deepEqual(closed.sheets[0].unattributed, []);
  // an agent's check is never a person's approval: review stays open
  assert.ok(closed.counts.needs_review > 0);

  // the carry is one undo step (after the five recheck steps above)
  session.undoLast(5);
  assert.equal(session.listShapes({ sheet: REV }).count, 17);
  session.undoLast(1);
  assert.equal(session.listShapes({ sheet: REV }).count, 0);
  assert.equal(session.listShapes({ sheet: BASE }).count, 17);
});

test("revision_delta refuses to carry across a scale it cannot trust", async () => {
  const session = await albany();
  session.setScale(BASE, { label: `3/16" = 1'-0"` });
  session.measurePolygon(BASE, [[2294, 626.5], [3477.5, 626.5], [3477.5, 3021.5], [2294, 3021.5]], { condition: "SC-1", role: "floor_area" });
  // the revised sheet's detected scale is the NEW DETAIL's 3/8", not the plan's 3/16"
  session.setScale(REV, { use_detected: true });
  const d = await session.revisionDelta({ base: BASE, revised: REV, carry: true });
  assert.equal(d.carry!.carried.length, 0);
  assert.match(d.carry!.skipped[0].reason, /scale differs/);
  assert.equal(session.listShapes({ sheet: REV }).count, 0);
});

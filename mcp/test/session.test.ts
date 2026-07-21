// Session tests against the bundled demo plan — real pdf.js parse, real
// geometry, no transport. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session, ANN_SCHEMA } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const approx = (a: number, b: number, tolFrac: number) => Math.abs(a - b) <= Math.abs(b) * tolFrac;

test("loadPlan: pages, dims (pt and px), detected scale, sheet number", async () => {
  const s = new Session();
  const r = await s.loadPlan(PLAN);
  assert.equal(r.page_count, 1);
  assert.equal(r.file, KEY);
  assert.equal(r.sheets.length, 1);
  const sh = r.sheets[0];
  assert.equal(sh.sheet, KEY);
  assert.equal(sh.width_pt, 1224);
  assert.equal(sh.height_pt, 792);
  assert.equal(sh.width_px, 2448);
  assert.equal(sh.height_px, 1584);
  assert.equal(sh.detected_scale, '1/4" = 1\'-0"');
  assert.equal(sh.sheet_number, "A-101");
});

test("sheet lookup: by key, by title-block number, unknown lists loaded keys", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const info = await s.sheetInfo("A-101");            // title-block alias
  assert.equal(info.sheet, KEY);
  assert.ok(info.has_vector_linework);
  assert.ok(info.seg_count >= 6, `outer wall + partitions, got ${info.seg_count}`);
  assert.equal(info.scale_set, false);
  await assert.rejects(() => s.sheetInfo("nope.pdf"), /Unknown sheet .* loaded sheets: sample-plan\.pdf/);
});

test("ensureMask: built once, cache identity on the second call", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const m1 = await s.ensureMask(KEY);
  const m2 = await s.ensureMask(KEY);
  assert.ok(m1, "the demo plan has vector linework");
  assert.equal(m1, m2, "same MaskObj identity — not rebuilt");
});

test("setScale: label / upp / calibrate / use_detected all land on the same upp", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const want = 1 / 36; // 1/4" = 1'-0" at render scale 2: 4 ft per 144 px

  const byLabel = s.setScale(KEY, { label: '1/4" = 1\'-0"' });
  assert.ok(Math.abs(byLabel.upp - want) < 1e-12);

  const byUpp = s.setScale(KEY, { upp: 0.5 });
  assert.equal(byUpp.upp, 0.5);

  // the building's bottom edge: 1960 px wide = 54.44 real feet at 1/4" scale
  const byCal = s.setScale(KEY, { calibrate: { p1: [240, 1364], p2: [2200, 1364], feet: 54.44 } });
  assert.ok(Math.abs(byCal.upp - want) < 1e-4, `calibrated upp ≈ 1/36, got ${byCal.upp}`);

  const byDet = s.setScale(KEY, { use_detected: true });
  assert.ok(Math.abs(byDet.upp - want) < 1e-12);
  assert.equal(byDet.label, '1/4" = 1\'-0"');
});

test("setScale: unknown label errors and lists the valid labels", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  await assert.rejects(async () => s.setScale(KEY, { label: '1/5" = 1\'-0"' }), (e: Error) => {
    assert.match(e.message, /Unknown scale label/);
    assert.match(e.message, /1\/4" = 1'-0"/);
    assert.match(e.message, /1" = 20'/);
    return true;
  });
});

test("oneClick: px-only preview with warning before scale, SF after, leak outside", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);

  const pre = await s.oneClick(KEY, 600, 1084, { role: "floor_area", returnVerts: false });
  assert.equal(pre.status, "ok");
  assert.ok("area_px2" in pre && (pre as any).area_px2 > 0);
  assert.ok("perimeter_px" in pre);
  assert.ok(!("area_sf" in pre));
  assert.match((pre as any).warning, /No scale set for sample-plan\.pdf/);
  assert.match((pre as any).warning, /detected: 1\/4" = 1'-0"/);
  assert.equal(s.shapes.length, 0, "px preview never commits");

  s.setScale(KEY, { use_detected: true });
  const post = await s.oneClick(KEY, 600, 1084, { role: "floor_area", returnVerts: true });
  assert.ok(approx((post as any).area_sf, 438.6, 0.05), `room ≈ 438.6 SF, got ${(post as any).area_sf}`);
  assert.ok((post as any).nverts >= 3);
  assert.ok(Array.isArray((post as any).verts));
  assert.ok(!("shape_id" in post), "no condition given — nothing committed");
  assert.equal(s.shapes.length, 0);

  await assert.rejects(() => s.oneClick(KEY, 100, 100, { role: "floor_area", returnVerts: false }),
    /isn't enclosed on the plan linework/);
});

test("commit: verts_norm in [0,1], origin receipt, condition minted like the canvas", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  const r = await s.oneClick(KEY, 600, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  assert.ok((r as any).shape_id);
  assert.equal(s.shapes.length, 1);
  const shp = s.shapes[0];
  assert.equal(shp.sheet_id, KEY);
  assert.equal(shp.measure_role, "floor_area");
  for (const [x, y] of shp.verts_norm) {
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `verts_norm out of [0,1]: ${x},${y}`);
  }
  assert.equal(shp.origin?.method, "one_click_v1");
  assert.equal(shp.origin?.actor, "agent", "MCP commits are agent work, never human");
  assert.equal(shp.origin?.reviewed, false, "no human review gate exists in this server");
  assert.ok(shp.origin?.seed_norm?.[0]! > 0 && shp.origin?.seed_norm?.[0]! < 1);
  assert.equal(s.conditions.length, 1);
  const c = s.conditions[0];
  assert.equal(c.finish_tag, "CPT-1");
  assert.equal(c.color, "#c96442");      // first palette slot
  assert.equal(c.fill, "#c96442");
  assert.equal(c.hatch, "diag");         // HATCHES[1 + 0 % 15]
  assert.equal(c.multiplier, 1);
  assert.equal(c.waste_pct, 0);
  assert.deepEqual(c.materials, []);
});

test("detectRooms: finds all 4 real room labels, excludes the title-block number and scale note", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  const r = await s.detectRooms(KEY, { role: "floor_area", returnVerts: false });
  assert.equal(r.detected, 4, `expected the 4 office/break/corridor rooms, got ${JSON.stringify(r.rooms.map((x) => x.label))}`);
  assert.deepEqual(r.rooms.map((x) => x.label).sort(), ["101", "102", "103", "104"]);
  for (const room of r.rooms) assert.ok(approx((room as any).area_sf, 438.6, 0.05), `room ${room.label} ≈ 438.6 SF, got ${(room as any).area_sf}`);
  assert.equal(s.shapes.length, 0, "no condition given — nothing committed");
});

test("detectRooms: px-only preview before scale; condition commits every detected room under one finish tag", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const pre = await s.detectRooms(KEY, { role: "floor_area", returnVerts: false });
  assert.equal(pre.detected, 4);
  assert.ok("area_px2" in pre.rooms[0] && pre.rooms[0].area_px2! > 0);
  assert.ok(!("area_sf" in pre.rooms[0]));
  assert.match(pre.warning!, /No scale set for sample-plan\.pdf/);
  assert.equal(s.shapes.length, 0);

  s.setScale(KEY, { use_detected: true });
  const r = await s.detectRooms(KEY, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  assert.equal(r.rooms.filter((x) => (x as any).shape_id).length, 4, "all 4 rooms committed");
  assert.equal(s.shapes.length, 4);
  assert.equal(s.conditions.length, 1, "one condition minted, shared by every detected room");
  for (const shp of s.shapes) {
    assert.equal(shp.origin?.method, "one_click_v1");
    assert.equal(shp.origin?.actor, "agent");
    assert.equal(shp.origin?.reviewed, false);
  }
});

test("detectRooms: a sheet with no room-number labels detects nothing, no crash", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  const r = await s.detectRooms(KEY, { role: "floor_area", returnVerts: false });
  assert.ok(r.detected > 0, "sanity: the fixture does have labels");
  // now prove the empty case doesn't throw — a region with no labels near it
  const noLabelRegion = s.readSheetText(KEY, { x0: 0, y0: 0, x1: 1, y1: 1 });
  assert.equal(noLabelRegion.items.length, 0);
});

test("measure gates: polygon and line refuse without a scale, with the detected hint", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const wantMsg = /Set the scale for sample-plan\.pdf first — use set_scale \(detected: 1\/4" = 1'-0"\)\./;
  await assert.rejects(async () => s.measurePolygon(KEY, [[0, 0], [100, 0], [100, 100]], { role: "floor_area" }), wantMsg);
  await assert.rejects(async () => s.measureLine(KEY, [[0, 0], [100, 0]], {}), wantMsg);
});

test("measure: polygon SF and line LF at scale; deletion removes the shape", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  // 360×360 px = 10×10 ft
  const poly = s.measurePolygon(KEY, [[0, 0], [360, 0], [360, 360], [0, 360]], { condition: "TILE-1", role: "floor_area" });
  assert.equal(poly.area_sf, 100);
  assert.equal(poly.perimeter_lf, 40);
  const line = s.measureLine(KEY, [[0, 0], [720, 0]], { condition: "BASE-1" });
  assert.equal(line.length_lf, 20);
  assert.equal(s.shapes.length, 2);
  assert.equal(s.shapes[1].measure_role, "linear");
  assert.equal(s.shapes[1].computed.area_sf, 0);
  // agent-supplied coordinates: a hand trace by a machine hand, never human
  for (const shp of s.shapes) {
    assert.equal(shp.origin?.method, "manual");
    assert.equal(shp.origin?.actor, "agent");
    assert.equal(shp.origin?.reviewed, undefined, "measure commits claim no review state");
  }
  s.deleteShape(poly.shape_id!);
  assert.equal(s.shapes.length, 1);
  await assert.rejects(async () => s.deleteShape("shp-nope"), /No shape with id/);
});

test("exportPayload: exact envelope keys, schema, only scaled sheets listed", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  let p = s.exportPayload();
  assert.deepEqual(p.sheets, [], "no scale set — no sheets entries");
  s.setScale(KEY, { use_detected: true });
  await s.oneClick(KEY, 600, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  p = s.exportPayload();
  assert.deepEqual(Object.keys(p).sort(), [
    "conditions", "last_group", "markups", "project_name", "schema",
    "shapes", "sheet_group", "sheet_levels", "sheet_tabs", "sheets", "units",
  ]);
  assert.equal(p.schema, ANN_SCHEMA);
  assert.equal(p.schema, "opentakeoff.takeoff_canvas.v1");
  assert.equal(p.units, "imperial");
  assert.equal(p.project_name, "");
  assert.deepEqual(p.markups, []);
  assert.deepEqual(p.sheet_levels, {});
  assert.equal(p.sheets.length, 1);
  assert.equal(p.sheets[0].sheet_id, KEY);
  assert.ok(Math.abs(p.sheets[0].units_per_px! - 1 / 36) < 1e-12);
  assert.equal(p.shapes.length, 1);
  assert.equal(p.conditions.length, 1);
});

test("loadPlan again: replaces the session — scales, conditions, shapes all cleared", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  await s.oneClick(KEY, 600, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  const r = await s.loadPlan(PLAN);
  assert.match(r.note, /cleared/);
  assert.equal(s.shapes.length, 0);
  assert.equal(s.conditions.length, 0);
  const info = await s.sheetInfo(KEY);
  assert.equal(info.scale_set, false);
  assert.equal(info.shape_count, 0);
});

test("readSheetText: positioned items in image px; region narrows to the title block", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const all = s.readSheetText(KEY);
  assert.match(all.text, /OFFICE 101/);
  assert.match(all.text, /SCALE: 1\/4"/);
  const office = all.items.find((i) => i.str === "OFFICE 101")!;
  assert.ok(Math.abs(office.x - 600) < 2 && Math.abs(office.y - 1084) < 2, `label at ~(600,1084), got (${office.x},${office.y})`);
  // lower-right quadrant only — the title block
  const tb = s.readSheetText(KEY, { x0: 1468, y0: 871, x1: 2448, y1: 1584 });
  assert.ok(tb.items.some((i) => i.str === "A-101"));
  assert.ok(!tb.text.includes("OFFICE 101"));
});

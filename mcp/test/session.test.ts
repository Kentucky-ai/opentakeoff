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

test("setScale reprices committed shapes — summary and export follow the NEW scale", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const quarter = s.setScale(KEY, { label: '1/4" = 1\'-0"' });
  assert.ok(!("repriced" in quarter), "nothing committed yet — no repriced field");

  // a 400×300 px rect and a 400 px line, committed at 1/4" scale
  const poly = s.measurePolygon(KEY, [[300, 300], [700, 300], [700, 600], [300, 600]], { condition: "LVT-1", role: "floor_area" });
  const line = s.measureLine(KEY, [[300, 700], [700, 700]], { condition: "TR-1" });

  // the late-recalibrate workflow: adopt a scale, measure, then correct the
  // scale. upp doubles → area ×4, length ×2 — and BOTH shapes must follow.
  const eighth = s.setScale(KEY, { label: '1/8" = 1\'-0"' });
  assert.equal((eighth as { repriced?: number }).repriced, 2, "both committed shapes repriced");
  const k = eighth.upp / quarter.upp;
  assert.equal(k, 2);

  const sum = s.summary() as unknown as { conditions: { finish_tag: string; floor_sf: number; lf: number }[] };
  const lvt = sum.conditions.find((c) => c.finish_tag === "LVT-1")!;
  const tr = sum.conditions.find((c) => c.finish_tag === "TR-1")!;
  // expectations from raw geometry × NEW upp (not round2(old)×k² — the reprice
  // re-derives from verts, so it does not inherit the commit's rounding)
  assert.ok(approx(lvt.floor_sf, 400 * 300 * eighth.upp * eighth.upp, 1e-3), `summary SF at NEW scale: ${lvt.floor_sf}`);
  assert.ok(approx(tr.lf, 400 * eighth.upp, 1e-3), `summary LF at NEW scale: ${tr.lf}`);
  assert.ok(approx(lvt.floor_sf, poly.area_sf * k * k, 1e-3), "≈ old-scale SF × k² (mod commit rounding)");
  assert.ok(approx(tr.lf, line.length_lf * k, 1e-3));

  // export payload coherent: saved computed matches the saved units_per_px —
  // the app hydrates this verbatim (it never recomputes on load)
  const pay = s.exportPayload();
  assert.equal(pay.sheets[0].units_per_px, eighth.upp);
  const rect = pay.shapes.find((x) => x.measure_role === "floor_area")!;
  assert.ok(approx(rect.computed.area_sf, 400 * eighth.upp * 300 * eighth.upp, 1e-3), `payload area prices verts × saved upp, got ${rect.computed.area_sf}`);
  const run = pay.shapes.find((x) => x.measure_role === "linear")!;
  assert.ok(approx(run.computed.perimeter_lf, 400 * eighth.upp, 1e-3));
  assert.equal(run.computed.area_sf, 0, "linear reprice mirrors measureLine — no border SF without a thickness");

  // setting the SAME scale again is a no-op — no reprice noise
  const again = s.setScale(KEY, { label: '1/8" = 1\'-0"' });
  assert.ok(!("repriced" in again));
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
  assert.equal(shp.origin?.reviewed, true);
  assert.ok(shp.origin?.seed_norm[0]! > 0 && shp.origin?.seed_norm[0]! < 1);
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

// Tool conformance — every tool, both directions (issue #27):
//   valid input   → an ok reply whose structuredContent parses against the
//                   tool's declared output schema (zod, from src/outputs.ts)
//                   and byte-matches the back-compat text item;
//   invalid input → a clean error surface, never a crash and never a poisoned
//                   session: semantic misuse is an isError reply with a JSON
//                   {error} payload; schema-invalid arguments are the SDK's
//                   -32602 input-validation error result.
// Wire-level stdio cleanliness is the dist smoke harness's job (smoke:dist);
// this file covers the tool contract as an in-memory MCP client sees it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import {
  loadPlanOutput, sheetInfoOutput, setScaleOutput, oneClickOutput, detectRoomsOutput,
  measurePolygonOutput, measureLineOutput, takeoffSummaryOutput,
  exportTakeoffOutput, deleteShapeOutput, readSheetTextOutput,
  findTextOutput, editMaterialsOutput, editConditionOutput, undoLastOutput,
  exportReportOutput, sheetGraphOutput, resolveTagOutput, findScheduleOutput,
  symbolSweepOutput, annotateOutput, listAnnotationsOutput,
  markVerdictOutput, deleteVerdictOutput,
} from "../src/outputs.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const NOT_A_PDF = fileURLToPath(new URL("../package.json", import.meta.url));
const KEY = "sample-plan.pdf";
const UPP = 1 / 36; // 1/4" = 1'-0" at render scale 2.0

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  load_plan: z.object(loadPlanOutput),
  sheet_info: z.object(sheetInfoOutput),
  set_scale: z.object(setScaleOutput),
  one_click: z.object(oneClickOutput),
  detect_rooms: z.object(detectRoomsOutput),
  measure_polygon: z.object(measurePolygonOutput),
  measure_line: z.object(measureLineOutput),
  takeoff_summary: z.object(takeoffSummaryOutput),
  export_takeoff: z.object(exportTakeoffOutput),
  delete_shape: z.object(deleteShapeOutput),
  read_sheet_text: z.object(readSheetTextOutput),
  find_text: z.object(findTextOutput),
  edit_materials: z.object(editMaterialsOutput),
  edit_condition: z.object(editConditionOutput),
  undo_last: z.object(undoLastOutput),
  export_report: z.object(exportReportOutput),
  sheet_graph: z.object(sheetGraphOutput),
  resolve_tag: z.object(resolveTagOutput),
  find_schedule: z.object(findScheduleOutput),
  symbol_sweep: z.object(symbolSweepOutput),
  annotate: z.object(annotateOutput),
  list_annotations: z.object(listAnnotationsOutput),
  mark_verdict: z.object(markVerdictOutput),
  delete_verdict: z.object(deleteVerdictOutput),
};

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session()).connect(st);
  const client = new Client({ name: "conformance", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

/** Valid-input direction: ok reply, structuredContent === parsed text, schema-valid. */
async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length === 1, `${name}: single content item`);
  assert.equal(res.content[0].type, "text");
  const data = JSON.parse(res.content[0].text);
  assert.equal(!!res.isError, false, `${name} unexpectedly failed: ${data.error}`);
  assert.deepEqual(res.structuredContent, data, `${name}: structuredContent mirrors the text item`);
  SCHEMAS[name].parse(res.structuredContent);
  return data;
}

/** Semantic-misuse direction: isError with a JSON {error} payload, no structuredContent. */
async function callErr(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.equal(!!res.isError, true, `${name} should have failed`);
  assert.equal(res.structuredContent, undefined, `${name}: error replies carry no structuredContent`);
  const data = JSON.parse(res.content[0].text);
  assert.equal(typeof data.error, "string");
  assert.ok(data.error.length > 0, `${name}: error message present`);
  return data.error;
}

/** Schema-invalid arguments: the SDK's input-validation error result, naming the tool. */
async function callViolation(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.equal(!!res.isError, true, `${name}: schema violation must be an error`);
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /MCP error -32602/, `${name}: -32602 input validation`);
  assert.match(res.content[0].text, new RegExp(`Invalid arguments for tool ${name}`));
}

test("every tool: canonical valid call → schema-valid structuredContent mirroring the text item", async () => {
  const client = await pair();

  const loaded = await callOk(client, "load_plan", { path: PLAN });
  assert.equal(loaded.page_count, 1);
  assert.deepEqual(
    { sheet: loaded.sheets[0].sheet, page: loaded.sheets[0].page, sheet_number: loaded.sheets[0].sheet_number },
    { sheet: KEY, page: 1, sheet_number: "A-101" },
  );

  // sheet_info before the scale: no upp key, scale_set false, linework present
  const infoBefore = await callOk(client, "sheet_info", { sheet: KEY });
  assert.equal(infoBefore.scale_set, false);
  assert.equal(infoBefore.upp, undefined);
  assert.ok(infoBefore.seg_count > 0);
  assert.equal(infoBefore.has_vector_linework, true);
  assert.equal(infoBefore.shape_count, 0);

  // title-block addressing resolves to the same sheet (case/space-insensitive)
  const byNumber = await callOk(client, "sheet_info", { sheet: "a-101" });
  assert.equal(byNumber.sheet, KEY);

  const scale = await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  assert.equal(scale.source, "detected");
  assert.ok(Math.abs(scale.upp - UPP) < 1e-12);

  // measure-only batch detection: every returned room is scaled, nothing commits
  const rooms = await callOk(client, "detect_rooms", { sheet: KEY });
  assert.ok(rooms.detected >= 1);
  assert.equal(rooms.rooms.length, rooms.detected);
  assert.equal(rooms.warning, undefined);
  for (const r of rooms.rooms) {
    assert.ok(r.label.length > 0);
    assert.ok(r.area_sf > 0 && r.perimeter_lf > 0);
    assert.equal(r.shape_id, undefined, "no condition passed — nothing committed");
  }

  const clicked = await callOk(client, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1", return_verts: true });
  assert.ok(clicked.area_sf > 50);
  assert.ok(clicked.perimeter_lf > 0);
  assert.ok(Array.isArray(clicked.verts) && clicked.verts.length === clicked.nverts);
  assert.ok(clicked.shape_id);

  // a 360-px (10-ft) square at 1/4" scale: exactly 100 SF, 40 LF
  const poly = await callOk(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "VCT-1" });
  assert.deepEqual({ area_sf: poly.area_sf, perimeter_lf: poly.perimeter_lf, nverts: poly.nverts }, { area_sf: 100, perimeter_lf: 40, nverts: 4 });
  assert.ok(poly.shape_id);

  // two 360-px legs: exactly 20 LF
  const line = await callOk(client, "measure_line", { sheet: KEY, pts: [[0, 0], [360, 0], [360, 360]], condition: "RB-1" });
  assert.deepEqual({ length_lf: line.length_lf, npts: line.npts }, { length_lf: 20, npts: 3 });
  assert.ok(line.shape_id);

  const summary = await callOk(client, "takeoff_summary");
  assert.equal(summary.conditions.length, 3);
  const byTag = Object.fromEntries(summary.conditions.map((r: any) => [r.finish_tag, r]));
  assert.equal(byTag["VCT-1"].floor_sf, 100);
  assert.equal(byTag["RB-1"].lf, 20);
  const rowSum = summary.conditions.reduce((a: number, r: any) => a + r.total_sf, 0);
  assert.ok(Math.abs(summary.totals.total_sf - rowSum) < 0.01, "grand total is the sum of the rows");

  const exported = await callOk(client, "export_takeoff");
  assert.equal(exported.schema, "opentakeoff.takeoff_canvas.v1");
  assert.deepEqual(exported.sheets, [{ sheet_id: KEY, units_per_px: UPP }]);
  assert.equal(exported.conditions.length, 3);
  assert.equal(exported.shapes.length, 3);
  assert.deepEqual(exported.shapes.map((s: any) => s.measure_role), ["floor_area", "floor_area", "linear"]);
  for (const s of exported.shapes) {
    assert.ok(s.verts_norm.every(([nx, ny]: [number, number]) => nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1), "verts_norm in [0,1]");
    assert.equal(s.origin.actor, "agent", "everything this server commits is agent-actored");
  }
  const ocShape = exported.shapes.find((s: any) => s.id === clicked.shape_id);
  assert.equal(ocShape.origin.method, "one_click_v1");
  assert.equal(ocShape.origin.reviewed, false, "no human review gate exists here");
  assert.ok(Array.isArray(ocShape.origin.seed_norm));
  assert.equal(exported.shapes.find((s: any) => s.id === poly.shape_id).origin.method, "manual");

  const text = await callOk(client, "read_sheet_text", { sheet: KEY });
  assert.ok(text.items.length >= 4);
  assert.ok(text.text.includes("OFFICE 101"));
  for (const it of text.items) assert.ok(Number.isFinite(it.x) && Number.isFinite(it.y));

  // region restriction: exactly the one label inside the window; an empty window is empty
  const region = await callOk(client, "read_sheet_text", { sheet: KEY, region: { x0: 500, y0: 1000, x1: 700, y1: 1200 } });
  assert.deepEqual(region.items, [{ str: "OFFICE 101", x: 600, y: 1084 }]);
  assert.equal(region.text, "OFFICE 101");
  const empty = await callOk(client, "read_sheet_text", { sheet: KEY, region: { x0: 0, y0: 0, x1: 10, y1: 10 } });
  assert.deepEqual({ items: empty.items, text: empty.text }, { items: [], text: "" });

  // "101" substring-matches both the room label and the sheet number ("A-101")
  const found = await callOk(client, "find_text", { sheet: KEY, q: "101" });
  assert.equal(found.count, 2);
  assert.deepEqual(found.hits.map((h: any) => h.str).sort(), ["A-101", "OFFICE 101"]);
  const foundRegion = await callOk(client, "find_text", { sheet: KEY, q: "office", region: { x0: 500, y0: 1000, x1: 700, y1: 1200 } });
  assert.deepEqual(foundRegion.hits.map((h: any) => h.str), ["OFFICE 101"]);

  const materials = await callOk(client, "edit_materials", { condition: "CPT-1", add: [
    { name: "Adhesive", per: 250, basis: "area", unit: "gal" },
  ] });
  assert.equal(materials.materials.length, 1);
  assert.equal(materials.materials[0].round, true);
  const matched = await callOk(client, "edit_materials", { condition: "CPT-1",
    patch: [{ id: materials.materials[0].id, fields: { per: 300 } }] });
  assert.equal(matched.materials[0].per, 300);

  // edit_condition: the waste/multiplier knobs actually move takeoff_summary's
  // nets (#131 — before this tool, an agent takeoff always shipped net === gross)
  const preRow = (await callOk(client, "takeoff_summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.deepEqual({ w: preRow.waste_pct, m: preRow.multiplier }, { w: 0, m: 1 }, "minted conditions start net === gross");
  const knobs = await callOk(client, "edit_condition", { condition: "CPT-1", waste_pct: 10, multiplier: 2 });
  assert.deepEqual({ w: knobs.waste_pct, m: knobs.multiplier }, { w: 10, m: 2 });
  const postRow = (await callOk(client, "takeoff_summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.ok(Math.abs(postRow.total_sf - preRow.total_sf * 2) < 0.05, "multiplier scales gross");
  assert.ok(Math.abs(postRow.total_sf_net - postRow.total_sf * 1.1) < 0.05, "waste lifts net over gross");
  assert.match(await callErr(client, "edit_condition", { condition: "NOPE-9", waste_pct: 5 }),
    /No condition "NOPE-9"\. Known tags: /);        // resolve-or-error — a typo must not mint
  assert.match(await callErr(client, "edit_condition", { condition: "CPT-1" }), /Nothing to change/);
  const undone = await callOk(client, "undo_last", { n: 1 });
  assert.equal(undone.steps[0].op, "condition");
  const revRow = (await callOk(client, "takeoff_summary")).conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.deepEqual({ w: revRow.waste_pct, m: revRow.multiplier }, { w: 0, m: 1 }, "undo restores both knobs verbatim");

  // export_report: the canvas Report document over MCP (#130) — computed buy
  // list included, math parity with the app's totals.js
  await callOk(client, "edit_condition", { condition: "CPT-1", waste_pct: 5 });
  const report = await callOk(client, "export_report");
  assert.equal(report.schema, "opentakeoff.report.v1");
  const rRow = report.conditions.find((r: any) => r.finish_tag === "CPT-1");
  assert.ok(rRow.shape_count > 0, "report rows are shape-bearing conditions only");
  assert.ok(Math.abs(rRow.total_sf_net - rRow.total_sf * 1.05) < 0.05, "net carries the waste knob");
  assert.equal(rRow.materials.length, 1, "the buy list rides the row — the thing summary strips and the canvas payload never computes");
  const mLine = rRow.materials[0];
  assert.equal(mLine.per, 300);
  assert.equal(mLine.qty, Math.ceil(mLine.basis_qty / 300 - 1e-9), "order qty = basis ÷ coverage, rounded up to whole purchase units");
  assert.deepEqual(report.materials, [{ name: "Adhesive", unit: "gal", qty: mLine.qty }], "project-wide roll-up sums by (name, unit)");
  assert.ok(["standard", "upp", "calibrated", "detected"].includes(report.sheets[0].scale_source), "scale provenance rides the report");
  assert.ok(report.totals.total_sf_net > report.totals.total_sf, "grand totals carry waste");
  assert.equal(report.project_name, null, "a headless session has no project of its own — null, never ''");
  assert.deepEqual(report.roll_goods, [], "roll_goods (#136) always emitted — empty until a condition carries a roll_setup");
  const labeled = await callOk(client, "export_report", { project_name: "Summit Phase 2" });
  assert.equal(labeled.project_name, "Summit Phase 2", "a consumer can label the document it prices from");
  await callOk(client, "edit_condition", { condition: "CPT-1", waste_pct: 0 });   // leave the session as the later tests expect

  const del = await callOk(client, "delete_shape", { shape_id: clicked.shape_id });
  assert.deepEqual(del, { deleted: clicked.shape_id, shape_count: 2 });

  const infoAfter = await callOk(client, "sheet_info", { sheet: KEY });
  assert.equal(infoAfter.scale_set, true);
  assert.ok(Math.abs(infoAfter.upp - UPP) < 1e-12);
  assert.equal(infoAfter.shape_count, 2);
});

test("view_sheet: image + meta reply, grid math pinned, overlay drawn, misuse clean", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });

  // the image tool's reply shape: PNG content item first, JSON meta second
  const callImage = async (args: Record<string, unknown>) => {
    const res: any = await client.callTool({ name: "view_sheet", arguments: args });
    assert.equal(!!res.isError, false, `view_sheet failed: ${res.content?.[0]?.text}`);
    assert.equal(res.content.length, 2, "image item + meta text item");
    assert.equal(res.content[0].type, "image");
    assert.equal(res.content[0].mimeType, "image/png");
    assert.equal(res.structuredContent, undefined, "no outputSchema → no structuredContent");
    const png = Buffer.from(res.content[0].data, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(res.content[1].type, "text");
    return { png, meta: JSON.parse(res.content[1].text) };
  };

  // before the scale: grid "auto" refuses toward set_scale, the drawing scale works
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, grid: "auto" }), /set_scale/);
  const gridded = await callImage({ sheet: KEY, px: 400, grid: "1/4" });
  assert.equal(gridded.meta.grid_px_per_foot, 36, "1/4\" = 1'-0\" → 36 image px per foot");
  assert.equal(Math.max(...gridded.meta.img_px), 400, "long edge honors the px budget");
  assert.equal(gridded.meta.page, 1);
  assert.equal(gridded.meta.overlay, false);

  // after set_scale, auto derives the same grid the drawing scale gave
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const auto = await callImage({ sheet: KEY, px: 400, grid: "auto" });
  assert.ok(Math.abs(auto.meta.grid_px_per_foot - 36) < 1e-6, "auto agrees with the detected 1/4\" scale");

  // a crop honors the region and maps back: square region → square image
  const crop = await callImage({ sheet: KEY, region: { x0: 100, y0: 100, x1: 460, y1: 460 }, px: 300 });
  assert.deepEqual(crop.meta.region, [100, 100, 460, 460]);
  assert.deepEqual(crop.meta.img_px, [300, 300]);
  assert.ok(Math.abs(crop.meta.zoom - 300 / 360) < 1e-3, "zoom = canvas px per image px");

  // overlay burns committed shapes in: same render differs byte-for-byte
  const clicked = await callOk(client, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1" });
  assert.ok(clicked.shape_id);
  const bare = await callImage({ sheet: KEY, px: 400 });
  const overlaid = await callImage({ sheet: KEY, px: 400, overlay: true });
  assert.equal(overlaid.meta.overlay, true);
  assert.equal(overlaid.meta.shapes_drawn, 1);
  assert.ok(!bare.png.equals(overlaid.png), "the overlay visibly changes the render");

  // misuse: degenerate region and junk grid are clean isError replies
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, region: { x0: 400, y0: 100, x1: 100, y1: 460 } }), /Empty view region/);
  assert.match(await callErr(client, "view_sheet", { sheet: KEY, grid: "banana" }), /inches-per-foot/);
});

test("before any plan: sheet tools and export refuse cleanly; summary is a valid empty reply", async () => {
  const client = await pair();
  const gate = /No plan loaded — call load_plan first\./;
  assert.match(await callErr(client, "sheet_info", { sheet: KEY }), gate);
  assert.match(await callErr(client, "view_sheet", { sheet: KEY }), gate);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, use_detected: true }), gate);
  assert.match(await callErr(client, "one_click", { sheet: KEY, x: 1, y: 1 }), gate);
  assert.match(await callErr(client, "detect_rooms", { sheet: KEY }), gate);
  assert.match(await callErr(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [1, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "measure_line", { sheet: KEY, pts: [[0, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "read_sheet_text", { sheet: KEY }), gate);
  assert.match(await callErr(client, "export_takeoff"), gate);
  assert.match(await callErr(client, "export_report"), gate);
  assert.match(await callErr(client, "delete_shape", { shape_id: "shp-nope" }), /No shape with id "shp-nope"\./);

  const summary = await callOk(client, "takeoff_summary");
  assert.deepEqual(summary.conditions, []);
  assert.equal(summary.totals.total_sf, 0);
});

test("unknown sheet: every sheet-addressed tool names the miss and lists what is loaded", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  const miss = /Unknown sheet "no-such-sheet" — loaded sheets: sample-plan\.pdf\./;
  assert.match(await callErr(client, "sheet_info", { sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "set_scale", { sheet: "no-such-sheet", use_detected: true }), miss);
  assert.match(await callErr(client, "one_click", { sheet: "no-such-sheet", x: 1, y: 1 }), miss);
  assert.match(await callErr(client, "detect_rooms", { sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "measure_polygon", { sheet: "no-such-sheet", verts: [[0, 0], [1, 0], [1, 1]] }), miss);
  assert.match(await callErr(client, "measure_line", { sheet: "no-such-sheet", pts: [[0, 0], [1, 1]] }), miss);
  assert.match(await callErr(client, "read_sheet_text", { sheet: "no-such-sheet" }), miss);
  assert.match(await callErr(client, "view_sheet", { sheet: "no-such-sheet" }), miss);
});

test("schema-invalid arguments: -32602 validation error naming the tool; the session survives", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });

  await callViolation(client, "load_plan", {});                                            // missing path
  await callViolation(client, "sheet_info", {});                                           // missing sheet
  await callViolation(client, "set_scale", { sheet: KEY, upp: "half" });                   // wrong type
  await callViolation(client, "one_click", { sheet: KEY, x: 600 });                        // missing y
  await callViolation(client, "one_click", { sheet: KEY, x: 600, y: 1084, role: "wall" }); // bad enum
  await callViolation(client, "detect_rooms", { sheet: KEY, role: "wall" });               // bad enum
  await callViolation(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [1, 1]] }); // min 3 verts
  await callViolation(client, "measure_line", { sheet: KEY, pts: [[0, 0]] });              // min 2 pts
  await callViolation(client, "delete_shape", {});                                         // missing shape_id
  await callViolation(client, "read_sheet_text", { sheet: KEY, region: { x0: 0, y0: 0, x1: 10 } }); // partial region
  await callViolation(client, "export_takeoff", { path: 42 });                             // path not a string
  await callViolation(client, "view_sheet", { sheet: KEY, px: 50 });                       // px below the 200 floor
  await callViolation(client, "view_sheet", { sheet: KEY, region: { x0: 0, y0: 0, x1: 10 } }); // partial region
  await callViolation(client, "find_text", { sheet: KEY });                                // missing q
  await callViolation(client, "find_text", { sheet: KEY, q: "101", limit: 0 });            // limit below min 1
  await callViolation(client, "symbol_sweep", { sheet: KEY });                             // missing seed_rect
  await callViolation(client, "symbol_sweep", { sheet: KEY, seed_rect: [[0, 0]] });        // one corner is not a rect
  await callViolation(client, "symbol_sweep", { sheet: KEY, seed_rect: [[0, 0], [50, 50]], tolerance_px: 0 }); // tolerance must be positive
  await callViolation(client, "annotate", { sheet: KEY, type: "measure" });                // bad type enum
  await callViolation(client, "edit_materials", { condition: "CPT-1", add: [{ per: 250 }] }); // add row missing name
  await callViolation(client, "edit_condition", { condition: "CPT-1", waste_pct: -5 });    // negative waste
  await callViolation(client, "edit_condition", { condition: "CPT-1", multiplier: 0 });    // 0 silently means 1 on the canvas — rejected
  await callViolation(client, "edit_condition", { condition: "CPT-1", waste_pct: "ten" }); // wrong type

  // none of that touched the session — a real call still works on the same pair
  const r = await callOk(client, "one_click", { sheet: KEY, x: 600, y: 1084 });
  assert.ok(r.area_sf > 50);
});

test("set_scale semantics: calibrate and upp modes, valid and degenerate", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });

  // 360 px spanning 10 real feet is exactly the detected 1/4" scale
  const cal = await callOk(client, "set_scale", { sheet: KEY, calibrate: { p1: [0, 0], p2: [360, 0], feet: 10 } });
  assert.equal(cal.source, "calibrate");
  assert.equal(cal.label, undefined);
  assert.ok(Math.abs(cal.upp - UPP) < 1e-12);

  const direct = await callOk(client, "set_scale", { sheet: KEY, upp: 0.5 });
  assert.deepEqual({ source: direct.source, upp: direct.upp }, { source: "upp", upp: 0.5 });

  assert.match(await callErr(client, "set_scale", { sheet: KEY, calibrate: { p1: [50, 50], p2: [50, 50], feet: 10 } }), /identical/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, calibrate: { p1: [0, 0], p2: [360, 0], feet: -5 } }), /feet must be positive/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, upp: 0 }), /upp must be a positive number/);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, label: "" }), /Unknown scale label/);
});

test("one_click misuse and a bad document: clean errors, and a failed load leaves an empty session", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });

  // a click in the sheet margin is not an enclosed space
  assert.match(await callErr(client, "one_click", { sheet: KEY, x: 5, y: 5 }), /isn't enclosed on the plan linework/);

  // loading a non-PDF fails cleanly — and load_plan's replace semantics mean
  // the previous document is gone, not half-kept
  await callErr(client, "load_plan", { path: NOT_A_PDF });
  assert.match(await callErr(client, "sheet_info", { sheet: KEY }), /No plan loaded/);

  // and the session recovers on the next good load
  const again = await callOk(client, "load_plan", { path: PLAN });
  assert.equal(again.page_count, 1);
});

test("export_takeoff: an unwritable path is isError and does not corrupt the inline export", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  // a parent directory that does not exist, valid on every platform
  const unwritable = path.join(tmpdir(), "opentakeoff-conformance-no-such-dir", "deep", "out.json");
  await callErr(client, "export_takeoff", { path: unwritable });
  const exported = await callOk(client, "export_takeoff");
  assert.equal(exported.schema, "opentakeoff.takeoff_canvas.v1");
});

test("deduct role: committed deducts subtract in the summary and export as measure_role deduct", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });

  // 100 SF floor minus a 25 SF (180-px / 5-ft square) deduct under the same tag
  await callOk(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "CPT-1" });
  const ded = await callOk(client, "measure_polygon", { sheet: KEY, verts: [[150, 150], [330, 150], [330, 330], [150, 330]], condition: "CPT-1", role: "deduct" });
  assert.equal(ded.area_sf, 25);

  const summary = await callOk(client, "takeoff_summary");
  assert.equal(summary.conditions.length, 1);
  assert.equal(summary.conditions[0].floor_sf, 75);

  const exported = await callOk(client, "export_takeoff");
  assert.deepEqual(exported.shapes.map((s: any) => s.measure_role), ["floor_area", "deduct"]);
});

// ── PDF layers (#85): the layered fixture drives the whole loop ─────────────
// test/fixtures/layered-plan.pdf (see scripts/make-layered-fixture.mjs): a
// 300×300 pt room on A-WALL-FULL, a 3×3 tile grid on A-FLOR-PATT (FOUR lines
// — far below HATCH_MIN_RUN, so pitch heuristics keep them hard and a naive
// flood traps in one cell), a leader on A-ANNO-TEXT crossing the room, and a
// demolition wall on A-WALL-DEMO hidden in the default config.
const LAYERED = fileURLToPath(new URL("./fixtures/layered-plan.pdf", import.meta.url));

test("layers (#85): the table reads, stated roles feed the mask, include/exclude bite, unlayered refuses", async () => {
  const client = await pair();
  const LKEY = "layered-plan.pdf";
  const loaded = await callOk(client, "load_plan", { path: LAYERED });
  assert.equal(loaded.page_count, 1);

  const info = await callOk(client, "sheet_info", { sheet: LKEY });
  const byName = Object.fromEntries(info.layers.map((l: any) => [l.name, l]));
  assert.deepEqual(Object.keys(byName).sort(), ["A-ANNO-TEXT", "A-FLOR-PATT", "A-WALL-DEMO", "A-WALL-FULL"]);
  assert.equal(byName["A-WALL-FULL"].role, "boundary");
  assert.equal(byName["A-FLOR-PATT"].role, "finish-pattern");
  assert.equal(byName["A-ANNO-TEXT"].role, "annotation");
  assert.deepEqual({ role: byName["A-WALL-DEMO"].role, visible: byName["A-WALL-DEMO"].visible },
    { role: "demolition", visible: false }, "hidden demolition arrives stated, not guessed");
  assert.ok(info.layers.every((l: any) => l.seg_count > 0 && l.confidence > 0.5), "every layer owns ink and classifies confidently");

  await callOk(client, "set_scale", { sheet: LKEY, upp: 1 / 24 });
  // seed (300, 924) image px = pdf (150, 150) — inside ONE tile cell. The
  // stated layers exclude the grid (pattern), the leader (annotation), and
  // the hidden demo wall, so the flood reaches the whole 25×25 ft room.
  const room = await callOk(client, "one_click", { sheet: LKEY, x: 300, y: 924, condition: "CPT-1" });
  assert.ok(Math.abs(room.area_sf - 625) < 20, `whole room, not a tile cell: ${room.area_sf} SF`);

  // provenance: a trace bounded by DECLARED layers says so on the wire
  const payload = await callOk(client, "export_takeoff");
  assert.equal(payload.shapes[0].origin.layer_bounded, true);

  // include: the hidden demolition wall becomes hard boundary — the room halves
  const half = await callOk(client, "one_click", { sheet: LKEY, x: 300, y: 924, layers: { include: ["A-WALL-DEMO"] } });
  assert.ok(Math.abs(half.area_sf - 312.5) < 15, `the included demo wall splits the room: ${half.area_sf} SF`);

  // exclude the boundary itself → nothing encloses (never a silent guess)
  assert.match(await callErr(client, "one_click", { sheet: LKEY, x: 300, y: 924, layers: { exclude: ["A-WALL-FULL"] } }), /isn't enclosed/);
  // unknown layer name → resolve-or-error, listing the sheet's actual layers
  assert.match(await callErr(client, "one_click", { sheet: LKEY, x: 300, y: 924, layers: { exclude: ["NOPE"] } }), /No layer "NOPE".*A-WALL-FULL/);

  // the unlayered world stays exactly as it was: empty table, and a layer
  // filter REFUSES rather than silently no-ops
  await callOk(client, "load_plan", { path: PLAN });
  const plain = await callOk(client, "sheet_info", { sheet: KEY });
  assert.deepEqual(plain.layers, []);
  assert.match(await callErr(client, "one_click", { sheet: KEY, x: 600, y: 1084, layers: { exclude: ["A-WALL-FULL"] } }), /no PDF layers/);
});

// ── the sheet graph (#87): the two-page demo set drives all three tools ─────
const FINISH_PLAN = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

test("sheet graph (#87): index, resolve with citations, refusal with reasons, find_schedule", async () => {
  const client = await pair();
  // the graph needs a document
  assert.match(await callErr(client, "sheet_graph"), /No plan loaded/);

  await callOk(client, "load_plan", { path: FINISH_PLAN });
  const g = await callOk(client, "sheet_graph");
  assert.equal(g.available, true);
  const roles = Object.fromEntries(g.sheets.map((s: any) => [s.sheet, s.role]));
  assert.equal(roles["sample-finish-plan.pdf"], "plan", "page 1 is the finish plan");
  assert.equal(roles["sample-finish-plan.pdf#2"], "schedule", "page 2 is the schedule sheet — its room-number column must NOT mint phantom rooms");
  assert.ok(g.counts.rooms >= 40, `the plan's room tags: ${g.counts.rooms}`);
  assert.ok(g.counts.schedules >= 2, "a room-finish table AND a finish/material table");
  assert.ok(g.rooms.every((r: any) => r.sheet === "sample-finish-plan.pdf"), "rooms come from the plan sheet only");
  const r134 = g.rooms.find((r: any) => r.tag === "134");
  assert.ok(r134 && r134.bbox.x1 > r134.bbox.x0, "a tag carries its bbox");

  // THE question: what finish is specified in room 134, and how do you know
  const res = await callOk(client, "resolve_tag", { tag: "134" });
  assert.equal(res.status, "resolved");
  const bySurface = Object.fromEntries(res.finishes.map((f: any) => [f.surface, f]));
  assert.equal(bySurface.FLOOR.code, "CPT-1/VCT-1", "the dual-finish floor cell survives verbatim");
  assert.equal(bySurface.BASE.code, "RB-1");
  assert.equal(bySurface.BASE.definition.cells.MATERIAL, "RESILIENT BASE", "the code chains to its material-schedule definition");
  for (const f of res.finishes) {
    assert.ok(f.source.sheet && f.source.bbox.x1 > f.source.bbox.x0, `${f.surface} carries a citation`);
  }
  assert.ok(res.sources.length >= 2, "the chain cites the plan tag AND the schedule row");

  // refusal over guessing: a tag with no row names the gap, never omits it
  const missing = await callOk(client, "resolve_tag", { tag: "999" });
  assert.equal(missing.status, "unresolved");
  assert.match(missing.reason, /no schedule row for 999/);

  const found = await callOk(client, "find_schedule", { kind: "room finish" });
  assert.ok(found.matches[0].rows >= 30);
  assert.match(found.matches[0].title, /ROOM FINISH SCHEDULE/);
  assert.ok(found.matches[0].region.x1 > found.matches[0].region.x0, "the region is viewable");
  assert.match(await callErr(client, "find_schedule", { kind: "door" }), /No "door" schedule found .* Found: /);
});

// ── the sheet graph, phase 2 (#87): continuation sheets, rotated headers, ───
// multi-building keys — the five-page fixture pins all three lanes end to end
// (generator: scripts/make-sheetgraph-fixture.mjs). Room 134 exists in BOTH
// buildings; building A's schedule is only readable through its rotated
// header band; building B's schedule continues onto page 5.
const MB_SET = fileURLToPath(new URL("./fixtures/multibuilding-set.pdf", import.meta.url));

test("sheet graph phase 2 (#87): continuation merges to ONE table, rotated headers anchor, multi-building refuses with candidates", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: MB_SET });

  const g = await callOk(client, "sheet_graph");
  assert.deepEqual(g.buildings, ["A", "B"], "the set's building designators");
  assert.equal(g.sheets[0].building, "A");
  assert.equal(g.sheets[1].building, "B");
  assert.equal(g.counts.schedules, 3, "LOGICAL tables: room-finish A, room-finish B (incl. its continuation), material");
  // rooms carry their building — the same number, twice, honestly
  const r134 = g.rooms.filter((r: any) => r.tag === "134");
  assert.deepEqual(r134.map((r: any) => r.building).sort(), ["A", "B"]);
  // the rotated header band is read and disclosed
  const schedA = g.sheets.find((s: any) => s.sheet === "multibuilding-set.pdf#3");
  assert.equal(schedA.schedules.find((x: any) => x.kind === "room-finish").rotated_headers, true);
  // the continuation fragment names its base
  const contd = g.sheets.find((s: any) => s.sheet === "multibuilding-set.pdf#5");
  assert.equal(contd.schedules[0].continues, "multibuilding-set.pdf#4");

  // refusal over first-match: unqualified 134 lists the candidates per building
  const amb = await callOk(client, "resolve_tag", { tag: "134" });
  assert.equal(amb.status, "unresolved");
  assert.match(amb.reason, /ambiguous: room 134 appears in 2 buildings/);
  assert.match(amb.reason, /qualify the tag/);
  assert.equal(amb.room, null, "citing one building's plan tag would be quietly wrong");
  assert.deepEqual(amb.candidates.map((c: any) => c.building).sort(), ["A", "B"]);

  // qualified tags pick the building the set names — through the ROTATED table
  const a = await callOk(client, "resolve_tag", { tag: "A-134" });
  assert.equal(a.status, "resolved");
  assert.equal(a.building, "A");
  assert.equal(a.room.name, "OFFICE", "building A's 134, not B's STORAGE");
  const aFloor = a.finishes.find((f: any) => f.surface === "FLOOR");
  assert.equal(aFloor.code, "CPT-1");
  assert.equal(aFloor.definition.cells.MATERIAL, "CARPET TILE", "the chain still reaches the material schedule");
  const b = await callOk(client, "resolve_tag", { tag: "B-134" });
  assert.equal(b.finishes.find((f: any) => f.surface === "FLOOR").code, "VCT-2");

  // a row carried by the CONT'D sheet resolves and cites the CONT'D sheet
  const cont = await callOk(client, "resolve_tag", { tag: "201" });
  assert.equal(cont.status, "resolved");
  assert.equal(cont.building, "B");
  assert.ok(cont.finishes.every((f: any) => f.source.sheet === "multibuilding-set.pdf#5"), "evidence points at the ink");

  // a building the set never names refuses by name, with the candidates
  const c = await callOk(client, "resolve_tag", { tag: "C-134" });
  assert.equal(c.status, "unresolved");
  assert.match(c.reason, /names no building "C"/);
  assert.equal(c.candidates.length, 2);

  // find_schedule: the continued table is ONE match with parts, base first
  const found = await callOk(client, "find_schedule", { kind: "room finish" });
  assert.equal(found.matches.length, 2, "two logical room-finish tables — A and B — not three fragments");
  const matchA = found.matches.find((m: any) => m.building === "A");
  assert.equal(matchA.rotated_headers, true);
  const matchB = found.matches.find((m: any) => m.building === "B");
  assert.equal(matchB.rows, 2, "total rows across fragments");
  assert.deepEqual(matchB.parts.map((p: any) => [p.sheet, p.rows]), [["multibuilding-set.pdf#4", 1], ["multibuilding-set.pdf#5", 1]]);
});

// 0.9.20 — symbol_sweep's output contract, both modes, schema round-tripped
// unstripped (the assign-mode deepEqual discipline: zod strips unknown keys,
// so equality proves the schema states EVERY returned field).
const SYMPLAN = fileURLToPath(new URL("./fixtures/symbol-plan.pdf", import.meta.url));

test("symbol_sweep: reply validates AND round-trips the schema unstripped, in read and commit modes", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: SYMPLAN });
  const read = await callOk(client, "symbol_sweep", { sheet: "symbol-plan.pdf", seed_rect: [[196, 980], [272, 1028]] });
  assert.deepEqual(z.object(symbolSweepOutput).parse(read), read, "schema states every returned field — nothing stripped");
  assert.equal(read.found, read.matches.length);
  assert.ok(read.withheld.every((w: any) => typeof w.reason === "string" && w.reason.length > 0));
  assert.equal(read.committed, undefined, "read mode commits nothing");

  const commit = await callOk(client, "symbol_sweep", { sheet: "symbol-plan.pdf", seed_rect: [[196, 980], [272, 1028]], commit: true, condition: "FD-1" });
  assert.deepEqual(z.object(symbolSweepOutput).parse(commit), commit);
  assert.equal(commit.committed, commit.found);
  assert.equal(commit.shape_ids.length, commit.found);
  assert.equal(commit.condition, "FD-1");
});

// dimension annotation (0.9.20): the annotate reply's schema covers the new
// length_lf field, both on annotate and on the list round-trip.
test("annotate dimension: reply validates against the schema, length rides the round-trip", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const dim = await callOk(client, "annotate", { sheet: KEY, type: "dimension", from: [100, 100], to: [460, 100] });
  assert.deepEqual(z.object(annotateOutput).parse(dim), dim, "schema states every returned field");
  assert.equal(dim.length_lf, 10);
});

// verdict marks (#176): both directions for the two new tools plus the
// extended list_annotations, with the unstripped deepEqual proving the
// schemas state EVERY field the tools actually return.
test("mark_verdict / delete_verdict / list_annotations verdicts: replies validate and round-trip the schema unstripped", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: PLAN });
  await callOk(client, "set_scale", { sheet: KEY, use_detected: true });
  const poly = await callOk(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "CPT-1" });

  const onShape = await callOk(client, "mark_verdict", { shape_id: poly.shape_id, text: "checked against walls" });
  assert.deepEqual(z.object(markVerdictOutput).parse(onShape), onShape, "schema states every returned field");
  assert.equal(onShape.actor, "agent");
  assert.equal(onShape.condition, "CPT-1");
  const onSheet = await callOk(client, "mark_verdict", { sheet: KEY, at: [900, 900] });
  assert.deepEqual(z.object(markVerdictOutput).parse(onSheet), onSheet);

  const listed = await callOk(client, "list_annotations", {});
  assert.deepEqual(z.object(listAnnotationsOutput).parse(listed), listed, "verdicts[] and verdict_count are fully stated");
  assert.equal(listed.verdict_count, 2);

  const del = await callOk(client, "delete_verdict", { verdict_id: onSheet.id });
  assert.deepEqual(z.object(deleteVerdictOutput).parse(del), del);

  // semantic misuse is a clean isError surface
  await callErr(client, "mark_verdict", {});                                              // no target
  await callErr(client, "mark_verdict", { shape_id: poly.shape_id, sheet: KEY, at: [1, 1] }); // both targets
  await callErr(client, "mark_verdict", { shape_id: "shp-nope" });                        // unknown shape
  await callErr(client, "delete_verdict", { verdict_id: "apr-nope" });                    // unknown record

  // schema violations are -32602, session unharmed
  await callViolation(client, "mark_verdict", { sheet: KEY, at: [100] });                 // one coordinate is not a point
  await callViolation(client, "mark_verdict", { shape_id: 42 });                          // wrong type
  await callViolation(client, "delete_verdict", {});                                      // missing id
  const alive = await callOk(client, "list_annotations", {});
  assert.equal(alive.verdict_count, 1, "the violations changed nothing");
});

// 0.9.18 — assign-from-schedule's output contract. The deepEqual is the
// load-bearing assertion: zod strips unknown keys, so a bare parse would pass
// with an incomplete schema — equality proves the schema states EVERY field
// the tool actually returns (unresolved[], withheld.unresolved, rooms[].condition).
test("detect_rooms assign mode: reply validates AND round-trips the schema unstripped", async () => {
  const client = await pair();
  await callOk(client, "load_plan", { path: FINISH_PLAN });
  await callOk(client, "set_scale", { sheet: "sample-finish-plan.pdf", use_detected: true });
  const r = await callOk(client, "detect_rooms", { sheet: "sample-finish-plan.pdf", assign_from_schedule: true });
  assert.deepEqual(z.object(detectRoomsOutput).parse(r), r, "schema states every returned field — nothing stripped");
  assert.ok(Array.isArray(r.unresolved), "assign mode always states the answer, empty array included");
  assert.equal(r.withheld.unresolved, r.unresolved.length, "the counter and the array agree");
});

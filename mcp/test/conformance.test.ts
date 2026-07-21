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

  const del = await callOk(client, "delete_shape", { shape_id: clicked.shape_id });
  assert.deepEqual(del, { deleted: clicked.shape_id, shape_count: 2 });

  const infoAfter = await callOk(client, "sheet_info", { sheet: KEY });
  assert.equal(infoAfter.scale_set, true);
  assert.ok(Math.abs(infoAfter.upp - UPP) < 1e-12);
  assert.equal(infoAfter.shape_count, 2);
});

test("before any plan: sheet tools and export refuse cleanly; summary is a valid empty reply", async () => {
  const client = await pair();
  const gate = /No plan loaded — call load_plan first\./;
  assert.match(await callErr(client, "sheet_info", { sheet: KEY }), gate);
  assert.match(await callErr(client, "set_scale", { sheet: KEY, use_detected: true }), gate);
  assert.match(await callErr(client, "one_click", { sheet: KEY, x: 1, y: 1 }), gate);
  assert.match(await callErr(client, "detect_rooms", { sheet: KEY }), gate);
  assert.match(await callErr(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [1, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "measure_line", { sheet: KEY, pts: [[0, 0], [1, 1]] }), gate);
  assert.match(await callErr(client, "read_sheet_text", { sheet: KEY }), gate);
  assert.match(await callErr(client, "export_takeoff"), gate);
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

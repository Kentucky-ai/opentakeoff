// Tool-layer tests over a real client/server pair on an in-memory transport —
// schemas, error surfaces, and the scale gate as an MCP client sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session());
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length === 1, `${name}: single content item`);
  assert.equal(res.content[0].type, "text");
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return output;
}

// undo_last and edit_materials are the tools that take no coordinates — one
// addresses this session's own command history, the other a condition's
// supporting-materials config — so the coordinate contract would be noise in
// their descriptions rather than orientation. Every other tool speaks image
// px and says so.
// link_annotation takes an id and a tag — no geometry crosses it, so the
// coordinate contract would be noise rather than clarity.
// export_marked_pdf takes a file path and writes a document — same reasoning.
// list_shapes returns ids and quantities, no geometry — same reasoning.
// derive_base takes shape ids and lineal feet — same reasoning.
// import_takeoff takes a file path — same reasoning.
const NO_COORDS = new Set(["undo_last", "edit_materials", "edit_condition", "export_report", "export_marked_pdf", "link_annotation", "list_shapes", "derive_base", "import_takeoff"]);

test("tools/list: all thirty-two tools, each described with the coordinate contract", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "annotate", "delete_shape", "derive_base", "detect_rooms", "edit_condition", "edit_materials", "edit_shape", "export_marked_pdf", "export_report",
    "export_takeoff", "find_schedule", "find_text", "import_takeoff",
    "link_annotation", "list_annotations", "list_shapes", "load_plan", "measure_line", "measure_polygon", "measure_surface", "one_click", "place_count",
    "read_sheet_text", "resolve_tag", "set_scale", "sheet_context", "sheet_graph", "sheet_info", "symbol_sweep", "takeoff_summary", "undo_last", "view_sheet",
  ]);
  for (const t of tools) {
    if (NO_COORDS.has(t.name)) continue;
    assert.match(t.description || "", /image px at render scale 2\.0/, `${t.name} carries the coordinate contract`);
  }
});

test("load_plan: happy path returns sheets; a missing file is isError, not a crash", async () => {
  const client = await pair();
  const good = await call(client, "load_plan", { path: PLAN });
  assert.equal(good.isError, false);
  assert.equal(good.data.page_count, 1);
  assert.equal(good.data.sheets[0].sheet, KEY);

  const bad = await call(client, "load_plan", { path: "/nowhere/missing-plan.pdf" });
  assert.equal(bad.isError, true);
  assert.ok(bad.data.error, "error message present");
});

test("one_click without a scale: ok result with px quantities and the warning", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const r = await call(client, "one_click", { sheet: KEY, x: 600, y: 1084 });
  assert.equal(r.isError, false);
  assert.ok(r.data.area_px2 > 0);
  assert.equal(r.data.area_sf, undefined);
  assert.match(r.data.warning, /No scale set .* set_scale \(detected: 1\/4" = 1'-0"\)/);
});

test("detect_rooms: batch-finds all 4 rooms via the wire, commits under one condition", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const preview = await call(client, "detect_rooms", { sheet: KEY });
  assert.equal(preview.isError, false);
  assert.equal(preview.data.detected, 4);
  assert.deepEqual(preview.data.rooms.map((r: any) => r.label).sort(), ["101", "102", "103", "104"]);
  assert.ok(preview.data.rooms.every((r: any) => !r.shape_id), "no condition — nothing committed");

  const committed = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  assert.equal(committed.isError, false);
  assert.ok(committed.data.rooms.every((r: any) => typeof r.shape_id === "string"));
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 1);
  assert.equal(summary.data.conditions[0].shape_count, 4);
});

// Regression for FINDING-2026-07-22: on a real sheet, detect_rooms reported 48
// "rooms" — 37 of them label-bubble floods under 5 SF, plus one region claimed by
// two labels and committed twice (589 SF double-counted). Every one traced
// cleanly, so the <3-vertex guard passed them and the schema tests passed too.
// What was missing was a contract on WITHHOLDING, so that is what these assert.
test("detect_rooms withholding: floor is enforced, reported, and never silent", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const normal = await call(client, "detect_rooms", { sheet: KEY, return_verts: true });
  assert.equal(normal.isError, false);
  assert.ok(normal.data.withheld, "withheld is always reported, even when nothing was withheld");
  assert.equal(typeof normal.data.withheld.total, "number");
  assert.equal(normal.data.withheld.min_area_sf, 5, "default plausibility floor");

  // No two reported rooms may share a ring — that is the double-count. Keyed on
  // real geometry: the fixture's rooms are congruent, so area would collide.
  const rings = normal.data.rooms.map((r: any) => JSON.stringify(r.verts));
  assert.ok(rings.every((v: string) => v !== undefined));
  assert.equal(new Set(rings).size, rings.length, "one region commits once");

  // Raise the floor above every room: all withheld, counted as implausible,
  // and — the part that actually matters — nothing committed.
  const strict = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1", min_area_sf: 1e6 });
  assert.equal(strict.isError, false);
  assert.equal(strict.data.detected, 0);
  assert.equal(strict.data.rooms.length, 0);
  assert.equal(strict.data.withheld.implausible, normal.data.detected);
  assert.match(strict.data.note, /withheld/);
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 0, "withheld rooms must not commit");
});

test("detect_rooms preview: the plausibility floor needs real units, so it waits for a scale", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const preview = await call(client, "detect_rooms", { sheet: KEY, min_area_sf: 1e6 });
  assert.equal(preview.isError, false);
  assert.equal(preview.data.withheld.implausible, 0, "no scale — no SF to judge, so the floor cannot apply");
  assert.equal(preview.data.withheld.min_area_sf, undefined);
  assert.ok(preview.data.detected > 0);
});

test("measure_polygon scale gate: exact refusal text with the detected hint", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const r = await call(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [100, 0], [100, 100]] });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, `Set the scale for ${KEY} first — use set_scale (detected: 1/4" = 1'-0").`);
});

test("set_scale: zero or several modes are rejected; one mode works", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const none = await call(client, "set_scale", { sheet: KEY });
  assert.equal(none.isError, true);
  assert.match(none.data.error, /exactly one of: label, upp, calibrate, use_detected/);

  const both = await call(client, "set_scale", { sheet: KEY, upp: 0.5, use_detected: true });
  assert.equal(both.isError, true);
  assert.match(both.data.error, /exactly one/);

  const one = await call(client, "set_scale", { sheet: KEY, use_detected: true });
  assert.equal(one.isError, false);
  assert.equal(one.data.source, "detected");
  assert.ok(Math.abs(one.data.upp - 1 / 36) < 1e-12);

  const badLabel = await call(client, "set_scale", { sheet: KEY, label: "3/7\" = 1'-0\"" });
  assert.equal(badLabel.isError, true);
  assert.match(badLabel.data.error, /Unknown scale label/);
});

test("tool tracing: opt-in structured metadata goes to stderr without result content", async () => {
  const client = await pair();
  const originalTrace = process.env.OPENTAKEOFF_MCP_TRACE;
  try {
    delete process.env.OPENTAKEOFF_MCP_TRACE;
    const quiet = await captureStderr(async () => {
      await call(client, "takeoff_summary");
    });
    assert.equal(quiet, "");

    process.env.OPENTAKEOFF_MCP_TRACE = "1";
    const traced = await captureStderr(async () => {
      await call(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [100, 0], [100, 100]] });
    });

    const lines = traced.trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event, "opentakeoff_mcp_tool_call");
    assert.equal(event.tool, "measure_polygon");
    assert.equal(event.sheet, KEY);
    assert.equal(event.is_error, true);
    assert.equal(typeof event.duration_ms, "number");
    assert.ok(event.duration_ms >= 0);
    assert.equal(typeof event.result_size, "number");
    assert.ok(event.result_size > 0);
    assert.doesNotMatch(traced, /Set the scale/);
    assert.doesNotMatch(traced, /verts/);
  } finally {
    if (originalTrace === undefined) delete process.env.OPENTAKEOFF_MCP_TRACE;
    else process.env.OPENTAKEOFF_MCP_TRACE = originalTrace;
  }
});

test("delete_shape: removes a committed shape; unknown id is isError", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const committed = await call(client, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1" });
  assert.ok(committed.data.shape_id);

  const del = await call(client, "delete_shape", { shape_id: committed.data.shape_id });
  assert.equal(del.isError, false);
  assert.equal(del.data.shape_count, 0);

  const gone = await call(client, "delete_shape", { shape_id: committed.data.shape_id });
  assert.equal(gone.isError, true);
  assert.match(gone.data.error, /No shape with id/);
});

// The deliverable contract (the "Jake ran a takeoff and got numbers, no
// markup" fix): the server must be able to hand back a marked-up planset,
// and its instructions must tell every client that the takeoff finishes there.
test("initialize: server instructions state the marked-planset finish", async () => {
  const client = await pair();
  assert.match(client.getInstructions() || "", /export_marked_pdf/);
  assert.match(client.getInstructions() || "", /marked-up planset/);
});

test("export_marked_pdf: refuses an empty session, then writes a real 2-page PDF at the default path", async () => {
  const client = await pair();
  // load from a tmp copy so the default output path lands in the tmp dir,
  // proving the "<plan dir>/<plan> - marked set.pdf" default — and never
  // writing artifacts next to the repo's bundled demo plan
  const dir = await mkdtemp(path.join(tmpdir(), "ot-marked-"));
  const tmpPlan = path.join(dir, "sample-plan.pdf");
  await copyFile(PLAN, tmpPlan);
  await call(client, "load_plan", { path: tmpPlan });

  const empty = await call(client, "export_marked_pdf", {});
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /Nothing to mark/);

  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  await call(client, "annotate", { sheet: KEY, type: "cloud", text: "verify substrate", condition: "CPT-1", rect: [[500, 900], [800, 1200]] });

  const r = await call(client, "export_marked_pdf", {});
  assert.equal(r.isError, false);
  assert.equal(r.data.path, path.join(dir, "sample-plan - marked set.pdf"));
  assert.equal(r.data.pages, 2);           // legend cover + the one marked sheet
  assert.equal(r.data.sheets_marked, 1);
  assert.equal(r.data.shapes_drawn, 4);    // the 4 detect_rooms commits
  assert.equal(r.data.annotations_drawn, 1);

  const bytes = await readFile(r.data.path);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  assert.equal(doc.getPageCount(), 2);

  // explicit path + project name honoured
  const out2 = path.join(dir, "custom-marked.pdf");
  const r2 = await call(client, "export_marked_pdf", { path: out2, project_name: "Bldg 28 test" });
  assert.equal(r2.isError, false);
  assert.equal(r2.data.path, out2);
  assert.equal((await readFile(out2)).subarray(0, 5).toString(), "%PDF-");
});

// #146 — the missing measure roles: wall SF and EA reach the wire.
test("measure_surface: refuses without a height (minting nothing), commits LF × height, height journals separately", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const bare = await call(client, "measure_surface", { sheet: KEY, pts: [[600, 400], [900, 400]], condition: "CT-W1" });
  assert.equal(bare.isError, true);
  assert.match(bare.data.error, /Set a height for CT-W1/);
  const sum0 = await call(client, "takeoff_summary");
  assert.equal(sum0.data.conditions.length, 0, "the refusal minted no condition");

  // 300 px at 1/4" = 1'-0" (36 px per real foot at render scale 2) = 8.33 LF; × 9 ft = 75 SF
  const r = await call(client, "measure_surface", { sheet: KEY, pts: [[600, 400], [900, 400]], condition: "CT-W1", height_ft: 9 });
  assert.equal(r.isError, false);
  assert.equal(r.data.height_ft, 9);
  assert.equal(r.data.length_lf, 8.33);
  assert.equal(r.data.area_sf, 75);
  const sum = await call(client, "takeoff_summary");
  assert.equal(sum.data.conditions[0].wall_sf, 75);

  // the height write and the trace are separate undo steps (H-then-trace)
  const undo = await call(client, "undo_last", { n: 2 });
  assert.deepEqual(undo.data.steps.map((s: any) => s.op), ["commit", "condition"]);

  // knob path: edit_condition height_ft, then measure without an explicit height
  await call(client, "measure_surface", { sheet: KEY, pts: [[0, 0], [96, 0]], condition: "CT-W2", height_ft: 10 });
  const knob = await call(client, "edit_condition", { condition: "CT-W2", height_ft: 8 });
  assert.equal(knob.data.height_ft, 8);
  const r2 = await call(client, "measure_surface", { sheet: KEY, pts: [[600, 400], [900, 400]], condition: "CT-W2" });
  assert.equal(r2.data.area_sf, 66.67); // 8.33 LF × 8 ft
});

test("place_count: EA with no scale set, one journal step for the sweep, marked set and summary carry them", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  // deliberately NO set_scale — EA is scale-free
  const r = await call(client, "place_count", { sheet: KEY, points: [[500, 500], [700, 500], [900, 500]], condition: "TR-1" });
  assert.equal(r.isError, false);
  assert.equal(r.data.committed, 3);
  assert.equal(r.data.ea_total, 3);
  assert.equal(r.data.shape_ids.length, 3);
  const sum = await call(client, "takeoff_summary");
  assert.equal(sum.data.conditions[0].ea, 3);

  // whole sweep = one undo step
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].shapes, 3);
  assert.equal(undo.data.shape_count, 0);

  // count markers move without a scale; edit preserves the EA
  const again = await call(client, "place_count", { sheet: KEY, points: [[500, 500]], condition: "TR-1" });
  const moved = await call(client, "edit_shape", { shape_id: again.data.shape_ids[0], verts: [[520, 520]] });
  assert.equal(moved.isError, false);
  assert.equal(moved.data.count, 1);
});

// #152 — the bid set, not the PDF, is the unit of work.
test("load_plan merge: two documents, one takeoff — cross-file graph, spanning marked set, refusals", async () => {
  const VA = fileURLToPath(new URL("../../web/public/demo/sample-finish-plan.pdf", import.meta.url));
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });

  // merge keeps everything and adds the second document's sheets
  const merged = await call(client, "load_plan", { path: VA, merge: true });
  assert.equal(merged.isError, false);
  assert.deepEqual(merged.data.files, [KEY, "sample-finish-plan.pdf"]);
  assert.equal(merged.data.page_count, 3);
  assert.match(merged.data.note, /kept/);
  assert.equal((await call(client, "takeoff_summary")).data.conditions[0].shape_count, 4, "merge kept the shapes");

  // work continues on the NEW document's sheets
  await call(client, "set_scale", { sheet: "sample-finish-plan.pdf", use_detected: true });
  const hit = (await call(client, "find_text", { sheet: "sample-finish-plan.pdf", q: "161" })).data.hits.find((h: any) => h.str.trim() === "161");
  const room = await call(client, "one_click", { sheet: "sample-finish-plan.pdf", x: hit.center[0], y: hit.center[1] + 18, condition: "CPT-1" });
  assert.equal(room.data.area_sf, 269.71, "the standing VA truth, on a merged document (re-pinned for the RFC #60 lattice classifier: finish-zone edge rows stay hard, so room 161 no longer annexes its patterned border — measurement-policy note 2 of the slice)");

  // the sheet graph spans the whole set
  const graph = await call(client, "sheet_graph", {});
  assert.equal(graph.data.available, true);
  const graphSheets = new Set(graph.data.sheets.map((s: any) => s.sheet.split("#")[0]));
  assert.ok(graphSheets.has(KEY) && graphSheets.has("sample-finish-plan.pdf"), "graph indexes both documents");

  // the marked set covers worked sheets from BOTH files
  const dir = await mkdtemp(path.join(tmpdir(), "ot-multidoc-"));
  const out = path.join(dir, "set.pdf");
  const pdf = await call(client, "export_marked_pdf", { path: out });
  assert.equal(pdf.isError, false);
  assert.equal(pdf.data.sheets_marked, 2);
  assert.equal(pdf.data.pages, 3); // cover + one sheet per file
  assert.equal((await readFile(out)).subarray(0, 5).toString(), "%PDF-");

  // refusal: merging an already-loaded file
  const dup = await call(client, "load_plan", { path: PLAN, merge: true });
  assert.equal(dup.isError, true);
  assert.match(dup.data.error, /already loaded/);

  // plain load replaces the whole set again
  const replaced = await call(client, "load_plan", { path: PLAN });
  assert.equal(replaced.data.page_count, 1);
  assert.deepEqual(replaced.data.files, [KEY]);
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 0);
});

// #151 — the way back in: resume, merge-by-tag, idempotent re-import.
test("import_takeoff: empty session adopts wholesale; worked session merges by tag; re-import is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ot-import-"));
  const exported = path.join(dir, "takeoff.json");

  // session A: trace and export
  const a = await pair();
  await call(a, "load_plan", { path: PLAN });
  await call(a, "set_scale", { sheet: KEY, use_detected: true });
  await call(a, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  await call(a, "export_takeoff", { path: exported });

  // fresh session B: import = resume (scale rides in, shapes stay pencil)
  const b = await pair();
  await call(b, "load_plan", { path: PLAN });
  const bad = await call(b, "import_takeoff", { path: path.join(dir, "nope.json") });
  assert.equal(bad.isError, true);
  const r = await call(b, "import_takeoff", { path: exported });
  assert.equal(r.isError, false);
  assert.equal(r.data.replaced, true);
  assert.equal(r.data.shapes_added, 4);
  assert.equal(r.data.shapes_pending, 4, "machine shapes stay pencil through the round-trip");
  assert.equal(r.data.scales_adopted, 1);
  assert.deepEqual(r.data.unknown_files, []);
  const sum = await call(b, "takeoff_summary");
  assert.equal(sum.data.conditions[0].shape_count, 4, "adopted scale makes quantities real");

  // re-import: idempotent — same ids skip
  const again = await call(b, "import_takeoff", { path: exported });
  assert.equal(again.data.shapes_added, 0);
  assert.equal(again.data.shapes_total, 4);

  // worked session C: same finish tag merges onto the local condition (its knobs win)
  const c = await pair();
  await call(c, "load_plan", { path: PLAN });
  await call(c, "set_scale", { sheet: KEY, use_detected: true });
  await call(c, "measure_polygon", { sheet: KEY, verts: [[100, 100], [200, 100], [200, 200], [100, 200]], condition: "CPT-1" });
  await call(c, "edit_condition", { condition: "CPT-1", waste_pct: 10 });
  const m = await call(c, "import_takeoff", { path: exported });
  assert.equal(m.data.replaced, false);
  assert.equal(m.data.conditions_merged, 1);
  assert.equal(m.data.conditions_added, 0);
  assert.equal(m.data.shapes_added, 4);
  const csum = await call(c, "takeoff_summary");
  assert.equal(csum.data.conditions.length, 1);
  assert.equal(csum.data.conditions[0].shape_count, 5);
  assert.equal(csum.data.conditions[0].waste_pct, 10, "the session's own knobs won the merge");

  // undo removes the imported shapes as one step; the local trace stays
  await call(c, "undo_last", { n: 1 });
  assert.equal((await call(c, "takeoff_summary")).data.conditions[0].shape_count, 1);
});

// #148 — perimeter − stated openings → committed base runs, all-or-nothing.
test("derive_base: nets stated openings per room, refuses bad claims whole, one undo step", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  const inv = await call(client, "list_shapes", { condition: "CPT-1" });
  const [room0, room1] = inv.data.shapes;

  // gross perimeters, no openings
  const gross = await call(client, "derive_base", { source_condition: "CPT-1", condition: "RB-1" });
  assert.equal(gross.isError, false);
  assert.equal(gross.data.committed, 4);
  assert.ok(gross.data.rooms.every((r: any) => r.openings_lf === 0 && r.net_lf === r.gross_lf));
  assert.equal(gross.data.total_lf, +gross.data.rooms.reduce((n: number, r: any) => n + r.net_lf, 0).toFixed(2));
  const summary = await call(client, "takeoff_summary");
  const rb = summary.data.conditions.find((c: any) => c.finish_tag === "RB-1");
  assert.equal(rb.lf, gross.data.total_lf);
  await call(client, "undo_last", { n: 1 }); // the whole derivation is one step

  // stated openings net out, stacking per room; provenance carries the claim
  const withOpen = await call(client, "derive_base", {
    source_condition: "CPT-1", condition: "RB-1",
    openings: [{ shape_id: room0.id, lf: 3 }, { shape_id: room0.id, lf: 3 }, { shape_id: room1.id, lf: 6 }],
  });
  assert.equal(withOpen.isError, false);
  const r0 = withOpen.data.rooms.find((r: any) => r.source_shape_id === room0.id);
  assert.equal(r0.openings_lf, 6);
  assert.equal(r0.net_lf, +(r0.gross_lf - 6).toFixed(2));
  const payload = await call(client, "export_takeoff", {});
  const base = payload.data.shapes.find((s: any) => s.id === r0.base_shape_id);
  assert.equal(base.origin.derived.from_shape_id, room0.id);
  assert.equal(base.origin.derived.openings_lf, 6);

  // refusals: all-or-nothing, and base never lands on its source tag
  const badId = await call(client, "derive_base", { source_condition: "CPT-1", condition: "RB-2", openings: [{ shape_id: "shp-nope", lf: 3 }] });
  assert.equal(badId.isError, true);
  const tooBig = await call(client, "derive_base", { source_condition: "CPT-1", condition: "RB-2", openings: [{ shape_id: room0.id, lf: 10000 }] });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.data.error, /meet or exceed/);
  const selfTag = await call(client, "derive_base", { source_condition: "CPT-1", condition: "CPT-1" });
  assert.equal(selfTag.isError, true);
  const rb2 = (await call(client, "takeoff_summary")).data.conditions.find((c: any) => c.finish_tag === "RB-2");
  assert.equal(rb2, undefined, "refused calls committed nothing");
});

// #150 — arrow and bubble: the two markup types flooring drawings use most.
test("annotate arrow/bubble: validated per type, round-trip through list_annotations in px, drawn in the marked set", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const noHead = await call(client, "annotate", { sheet: KEY, type: "arrow", from: [100, 100] });
  assert.equal(noHead.isError, true);
  assert.match(noHead.data.error, /arrow needs from.*and to/);

  const arrow = await call(client, "annotate", { sheet: KEY, type: "arrow", text: "ALIGN CPT TO WALL", from: [600, 900], to: [900, 900], condition: "CPT-1" });
  assert.equal(arrow.isError, false);
  const bubble = await call(client, "annotate", { sheet: KEY, type: "bubble", text: "K3", at: [1200, 500], r: 40 });
  assert.equal(bubble.isError, false);

  const listed = await call(client, "list_annotations", {});
  const la = listed.data.annotations.find((m: any) => m.type === "arrow");
  const lb = listed.data.annotations.find((m: any) => m.type === "bubble");
  assert.deepEqual(la.from, [600, 900]);
  assert.deepEqual(la.to, [900, 900]);
  assert.equal(la.condition, "CPT-1");
  assert.deepEqual(lb.at, [1200, 500]);
  assert.equal(lb.r, 40);

  // both burn into the marked set (annotations alone mark a sheet)
  const dir = await mkdtemp(path.join(tmpdir(), "ot-arrow-"));
  const out = path.join(dir, "m.pdf");
  const pdf = await call(client, "export_marked_pdf", { path: out });
  assert.equal(pdf.isError, false);
  assert.equal(pdf.data.annotations_drawn, 2);
  assert.equal((await readFile(out)).subarray(0, 5).toString(), "%PDF-");

  // a bubble with no r stores the canvas default (2% of sheet width = 48.96 px on the 2448-px sheet)
  await call(client, "annotate", { sheet: KEY, type: "bubble", text: "K4", at: [300, 300] });
  const again = await call(client, "list_annotations", {});
  const lb2 = again.data.annotations.find((m: any) => m.text === "K4");
  assert.ok(Math.abs(lb2.r - 48.96) < 0.1);
});

// 0.9.18 — assign-from-schedule: the accurate path becomes the easy path. One
// call routes every detected room through its OWN schedule row, commits each
// under the FLOOR finish that row states, and withholds what the schedule
// cannot answer for — the batch one-shot that is also honest. (The 07-31
// Excel session's 12×-over batch happened because the natural call committed
// 21 rooms under ONE agent-chosen tag; this is the tool-shaped fix.)
test("detect_rooms assign_from_schedule: each room commits under its own row; unresolved withheld with reasons and seeds", async () => {
  const FINISH = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));
  const FKEY = "sample-finish-plan.pdf";
  const client = await pair();
  await call(client, "load_plan", { path: FINISH });
  await call(client, "set_scale", { sheet: FKEY, use_detected: true });

  const r = await call(client, "detect_rooms", { sheet: FKEY, assign_from_schedule: true });
  assert.equal(r.isError, false);
  // pinned from the first observed run — deterministic flood + fixture; re-pinned
  // for the RFC #60 engine (sealed ladder + lattice classifier shift which label
  // seeds flood clean: 7/19 -> 6/17, same contract, better boundaries)
  assert.equal(r.data.detected, 6);
  assert.ok(r.data.rooms.every((x: any) => typeof x.shape_id === "string" && typeof x.condition === "string"),
    "every reported room committed, each carrying the tag it committed under");
  const tags = new Set(r.data.rooms.map((x: any) => x.condition));
  assert.equal(tags.size, 6, `distinct finishes from distinct rows — the whole point (6 rooms, 6 rows after the RFC #60 re-pin). Got: ${[...tags].join(",")}`);
  assert.ok([...tags].every((t: any) => !/[/,]/.test(t)), "no minted tag is a compound literal");

  // the never-guesses contract: withheld rooms are reported with their real
  // geometry and a reason, never committed and never dropped
  assert.equal(r.data.withheld.unresolved, 17);
  assert.equal(r.data.unresolved.length, 17);
  for (const u of r.data.unresolved) {
    assert.ok(u.reason.length > 0, "every withheld room says why");
    assert.ok(u.area_sf > 0 && u.perimeter_lf > 0, "withheld from committing, not from reporting");
    assert.equal(u.seed.length, 2, "the seed turns 'ask the estimator' into 'one_click here'");
    assert.equal(u.shape_id, undefined, "nothing unresolved committed");
  }

  // provenance: the schedule verdict and its citation ride every commit
  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.shapes.length, 6);
  for (const shp of payload.data.shapes) {
    assert.equal(shp.origin.assignment.source, "schedule");
    assert.ok(shp.origin.assignment.room_tag, "the room tag that resolved");
    assert.equal(shp.origin.assignment.surface, "FLOOR");
    assert.equal(shp.origin.assignment.schedule_sheet, `${FKEY}#2`, "the citation names the schedule sheet");
  }
  const inv = await call(client, "list_shapes", {});
  assert.ok(inv.data.shapes.every((x: any) => x.assignment === "schedule"), "list_shapes carries the flat verdict");
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 6);
  assert.equal(summary.data.conditions.reduce((n: number, c: any) => n + c.shape_count, 0), 6);

  // mutual exclusion: both finish-tag sources at once is a contradiction,
  // refused before any flooding — nothing minted, nothing committed
  const both = await call(client, "detect_rooms", { sheet: FKEY, condition: "CPT-1", assign_from_schedule: true });
  assert.equal(both.isError, true);
  assert.match(both.data.error, /at most one of/);
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 6, "the refusal changed nothing");

  // a reassign onto a different tag is the agent choosing the finish — the
  // schedule verdict (and its citation) must not survive that edit; undo
  // restores the origin verbatim, verdict included
  const target = inv.data.shapes[0];
  await call(client, "edit_shape", { shape_id: target.id, condition: "VCT-9" });
  const after = await call(client, "list_shapes", {});
  assert.equal(after.data.shapes.find((x: any) => x.id === target.id).assignment, "asserted", "reassigned = asserted");
  await call(client, "undo_last", { n: 1 });
  const restored = await call(client, "list_shapes", {});
  assert.equal(restored.data.shapes.find((x: any) => x.id === target.id).assignment, "schedule", "undo restores the verdict");
});

test("detect_rooms assign_from_schedule refusals: no scale, and no schedule in the set — whole-set errors, nothing minted", async () => {
  const FINISH = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));
  const FKEY = "sample-finish-plan.pdf";
  const client = await pair();

  // the mode exists to COMMIT — a px-only preview wearing a success reply
  // would be a no-op pretending otherwise
  await call(client, "load_plan", { path: FINISH });
  const unscaled = await call(client, "detect_rooms", { sheet: FKEY, assign_from_schedule: true });
  assert.equal(unscaled.isError, true);
  assert.match(unscaled.data.error, /Set the scale for/);

  // a set with no room-finish schedule is a whole-set failure, named once —
  // not 60 withheld rooms for the same reason 60 times
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const noSched = await call(client, "detect_rooms", { sheet: KEY, assign_from_schedule: true });
  assert.equal(noSched.isError, true);
  assert.match(noSched.data.error, /No room-finish schedule .* merge: true/);
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 0, "refusals mint nothing");

  // outside assign mode the new counter is present and zero — the counts
  // object keeps a stable shape
  const normal = await call(client, "detect_rooms", { sheet: KEY });
  assert.equal(normal.isError, false);
  assert.equal(normal.data.withheld.unresolved, 0);
  assert.equal(normal.data.unresolved, undefined, "unresolved[] is an assign-mode statement, absent otherwise");
});

// #149 — the inventory read every mutating tool assumes you have.
test("list_shapes: compact inventory, filters narrow, empty is a result", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  await call(client, "place_count", { sheet: KEY, points: [[500, 500]], condition: "TR-1" });

  const all = await call(client, "list_shapes", {});
  assert.equal(all.isError, false);
  assert.equal(all.data.count, 5);
  const roles = all.data.shapes.map((s: any) => s.measure_role);
  assert.equal(roles.filter((r: string) => r === "floor_area").length, 4);
  assert.equal(roles.filter((r: string) => r === "count").length, 1);
  assert.ok(all.data.shapes.every((s: any) => s.reviewed === false), "everything this server commits is pencil");

  const byCond = await call(client, "list_shapes", { condition: "TR-1" });
  assert.equal(byCond.data.count, 1);
  assert.equal(byCond.data.shapes[0].count, 1);

  // an id from the inventory drives edit_shape directly
  const target = all.data.shapes.find((s: any) => s.measure_role === "floor_area");
  const del = await call(client, "delete_shape", { shape_id: target.id });
  assert.equal(del.isError, false);
  assert.equal((await call(client, "list_shapes", {})).data.count, 4);

  const badCond = await call(client, "list_shapes", { condition: "NOPE" });
  assert.equal(badCond.isError, true);
});

// #147 — roll goods reach the wire: the opt-in knob, the figured echo, the
// report block, and the exact undo.
test("edit_condition roll_setup: opt-in figures the order, report carries it, null opts out, undo restores verbatim", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });

  const on = await call(client, "edit_condition", { condition: "CPT-1", roll_setup: { material: "carpet" } });
  assert.equal(on.isError, false);
  assert.equal(on.data.roll_setup.material, "carpet");
  assert.equal(on.data.roll_setup.roll_width_ft, 12, "engine defaults minted");
  assert.equal(on.data.roll_setup.price_unit, "sy", "carpet sells sy");
  assert.ok(on.data.roll, "figured order echoed — floor shapes exist on a scaled sheet");
  assert.ok(on.data.roll.cuts > 0);
  assert.ok(on.data.roll.order_lf > 0);
  assert.equal(on.data.roll.order_unit, "sy");

  // same-material partial edit patches, keeps the rest
  const patched = await call(client, "edit_condition", { condition: "CPT-1", roll_setup: { roll_width_ft: 6 } });
  assert.equal(patched.data.roll_setup.roll_width_ft, 6);
  assert.equal(patched.data.roll_setup.material, "carpet");
  assert.ok(patched.data.roll.order_lf > on.data.roll.order_lf, "half the roll width ⇒ more lineal footage");

  // the report block carries the same figures
  const rep = await call(client, "export_report", {});
  assert.equal(rep.data.roll_goods.length, 1);
  assert.equal(rep.data.roll_goods[0].finish_tag, "CPT-1");
  assert.equal(rep.data.roll_goods[0].order_lf, patched.data.roll.order_lf);

  // opt out; then undo restores the width-6 setup verbatim
  const off = await call(client, "edit_condition", { condition: "CPT-1", roll_setup: null });
  assert.equal(off.data.roll_setup, undefined);
  assert.equal((await call(client, "export_report", {})).data.roll_goods.length, 0);
  await call(client, "undo_last", { n: 1 });
  const rep2 = await call(client, "export_report", {});
  assert.equal(rep2.data.roll_goods.length, 1);
  assert.equal(rep2.data.roll_goods[0].roll_width_ft, 6);
});

test("output contract: every JSON tool declares outputSchema; structuredContent mirrors the text item", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  for (const t of tools) {
    if (t.name === "view_sheet") {
      // the one image tool: replies are an image + meta text item, so there is
      // deliberately no outputSchema and no structuredContent
      assert.equal((t as any).outputSchema, undefined, "view_sheet declares no outputSchema");
      continue;
    }
    const schema: any = (t as any).outputSchema;
    assert.ok(schema && schema.type === "object", `${t.name} declares an object outputSchema`);
    assert.ok(schema.properties && Object.keys(schema.properties).length > 0, `${t.name} outputSchema has properties`);
  }
  // A structured reply validates AND byte-matches the back-compat text item.
  const res: any = await client.callTool({ name: "load_plan", arguments: { path: PLAN } });
  assert.equal(!!res.isError, false);
  assert.ok(res.structuredContent, "structuredContent present");
  assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text), "structuredContent === parsed text content");
  // Error replies stay plain isError results — no structuredContent required.
  const bad: any = await client.callTool({ name: "sheet_info", arguments: { sheet: "no-such-sheet" } });
  assert.equal(!!bad.isError, true);
  assert.equal(bad.structuredContent, undefined);
});

// ── The command algebra: the agent revises and retracts its OWN work ──────────
// Before this, the agent could only append. A proposal that overshot had to be
// deleted and re-derived from scratch; a sweep committed under the wrong
// condition meant N deletes. These are the two verbs that close that gap.

test("edit_shape: moves geometry, reassigns, flips role — and re-measures every time", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const square = [[100, 100], [300, 100], [300, 300], [100, 300]];
  const made = await call(client, "measure_polygon", { sheet: KEY, verts: square, condition: "CPT-1" });
  assert.equal(made.isError, false);
  const id = made.data.shape_id;
  const area0 = made.data.area_sf;
  assert.ok(area0 > 0);

  // Geometry: half the width => half the area, recomputed server-side.
  const moved = await call(client, "edit_shape", { shape_id: id, verts: [[100, 100], [200, 100], [200, 300], [100, 300]] });
  assert.equal(moved.isError, false);
  assert.deepEqual(moved.data.changed, ["verts"]);
  assert.ok(Math.abs(moved.data.area_sf - area0 / 2) < 0.01, `half area: ${moved.data.area_sf} vs ${area0 / 2}`);
  assert.equal(moved.data.agent_edits, 1);

  // Reassign: the shape moves to a second condition, and the totals follow.
  const reassigned = await call(client, "edit_shape", { shape_id: id, condition: "VCT-2" });
  assert.equal(reassigned.isError, false);
  assert.deepEqual(reassigned.data.changed, ["condition"]);
  assert.equal(reassigned.data.agent_edits, 2);
  const summary = await call(client, "takeoff_summary");
  const byTag = Object.fromEntries(summary.data.conditions.map((c: any) => [c.finish_tag, c.shape_count]));
  assert.equal(byTag["CPT-1"], 0, "left the old condition");
  assert.equal(byTag["VCT-2"], 1, "landed on the new one");

  // Role flip alone re-measures: a closed ring read as an open polyline.
  const linear = await call(client, "edit_shape", { shape_id: id, role: "linear" });
  assert.equal(linear.isError, false);
  assert.equal(linear.data.measure_role, "linear");
  assert.equal(linear.data.area_sf, 0, "a linear shape carries no area");
  assert.ok(linear.data.perimeter_lf > 0);

  // Provenance: agent self-revision never touches the human-correction fields.
  const payload = await call(client, "export_takeoff");
  const shape = payload.data.shapes.find((s: any) => s.id === id);
  assert.equal(shape.origin.agent_edits, 3);
  assert.equal(shape.origin.edited, undefined, "agent self-revision is not a human correction");
  assert.equal(shape.origin.edits, undefined);
  assert.equal(shape.origin.proposed_verts_norm, undefined, "nothing froze — no human has reviewed this");
});

test("edit_shape refusals: unknown id, empty patch, too few verts, and human ink", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const made = await call(client, "measure_polygon", {
    sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1",
  });
  const id = made.data.shape_id;

  const unknown = await call(client, "edit_shape", { shape_id: "shp-nope", verts: [[0, 0], [1, 0], [1, 1]] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /No shape with id/);

  const empty = await call(client, "edit_shape", { shape_id: id });
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /at least one of verts, condition, role/);

  const thin = await call(client, "edit_shape", { shape_id: id, verts: [[0, 0], [10, 10]] });
  assert.equal(thin.isError, true);
  assert.match(thin.data.error, /at least 3 vertices/);

  // The review gate is absolute: reviewed work is ink and no agent verb touches
  // it. This server never sets the flag, so it is set directly here — the guard
  // is the contract that makes this surface safe to port to a host that has a
  // real review gate.
  const session = new Session();
  await session.loadPlan(PLAN);
  session.setScale(KEY, { use_detected: true });
  const inkId = session.measurePolygon(KEY, [[100, 100], [300, 100], [300, 300]], { role: "floor_area", condition: "CPT-1" }).shape_id!;
  session.shapes.find((s) => s.id === inkId)!.origin!.reviewed = true;
  assert.throws(() => session.editShape(inkId, { condition: "VCT-2" }), /affirmed by a human/);
});

test("undo_last: a sweep is one step, an edit restores verbatim, a delete comes back", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  // A whole detect_rooms sweep undoes as ONE gesture, not four.
  const sweep = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  assert.equal(sweep.data.detected, 4);
  const back = await call(client, "undo_last", { n: 1 });
  assert.equal(back.isError, false);
  assert.equal(back.data.undone, 1);
  assert.equal(back.data.steps[0].op, "commit");
  assert.equal(back.data.steps[0].tool, "detect_rooms");
  assert.equal(back.data.steps[0].shapes, 4, "the sweep's four rooms, one step");
  assert.equal(back.data.shape_count, 0);

  // An edit restores the pre-edit shape verbatim.
  const made = await call(client, "measure_polygon", {
    sheet: KEY, verts: [[100, 100], [300, 100], [300, 300], [100, 300]], condition: "CPT-1",
  });
  const id = made.data.shape_id;
  const area0 = made.data.area_sf;
  await call(client, "edit_shape", { shape_id: id, verts: [[100, 100], [200, 100], [200, 300], [100, 300]] });
  const undoEdit = await call(client, "undo_last", { n: 1 });
  assert.equal(undoEdit.data.steps[0].op, "edit");
  const restored = (await call(client, "export_takeoff")).data.shapes.find((s: any) => s.id === id);
  assert.ok(Math.abs(restored.computed.area_sf - area0) < 0.01, "geometry is back to the original");

  // A delete comes back where it was.
  await call(client, "delete_shape", { shape_id: id });
  assert.equal((await call(client, "takeoff_summary")).data.conditions[0].shape_count, 0);
  const undoDelete = await call(client, "undo_last", { n: 1 });
  assert.equal(undoDelete.data.steps[0].op, "delete");
  assert.equal(undoDelete.data.shape_count, 1);

  // Running past the end is honest, not an error.
  const past = await call(client, "undo_last", { n: 50 });
  assert.equal(past.isError, false);
  assert.ok(past.data.undone < 50);
  assert.match(past.data.note, /Only \d+ step/);
  assert.equal(past.data.remaining, 0);
});

test("undo_last: reads are never journaled, and load_plan clears the history", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1" });

  // Look at the sheet, measure without committing, read text — none of it is a
  // gesture, so undo still steps over the one thing that actually changed state.
  await call(client, "read_sheet_text", { sheet: KEY });
  await call(client, "measure_polygon", { sheet: KEY, verts: [[10, 10], [20, 10], [20, 20]] });
  await call(client, "sheet_info", { sheet: KEY });
  const back = await call(client, "undo_last", { n: 1 });
  assert.equal(back.data.undone, 1);
  assert.equal(back.data.shape_count, 0, "the committed shape, not a read");
  assert.equal(back.data.remaining, 0, "the reads left no steps behind");

  // A new document invalidates every id the journal refers to.
  await call(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1" });
  await call(client, "load_plan", { path: PLAN });
  const afterLoad = await call(client, "undo_last", { n: 1 });
  assert.equal(afterLoad.data.undone, 0, "history goes with the document it described");
  assert.equal(afterLoad.data.remaining, 0);
});

test("find_text: locates a room label, region narrows the search, limit caps it", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  // "101" substring-matches BOTH the room label AND the sheet number in the
  // title block ("OFFICE 101" and "A-101") — real substring-search behavior,
  // not a bug; a narrower query is how an agent disambiguates.
  const hit = await call(client, "find_text", { sheet: KEY, q: "101" });
  assert.equal(hit.isError, false);
  assert.equal(hit.data.count, 2);
  assert.equal(hit.data.hits.length, 2);
  assert.deepEqual(hit.data.hits.map((h: any) => h.str).sort(), ["A-101", "OFFICE 101"]);
  assert.equal(hit.data.hits[0].bbox.length, 4);
  assert.equal(hit.data.hits[0].center.length, 2);
  assert.equal(hit.data.truncated, false);

  // a query specific enough to disambiguate finds exactly the room label
  const room = await call(client, "find_text", { sheet: KEY, q: "OFFICE 101" });
  assert.equal(room.isError, false);
  assert.equal(room.data.count, 1);
  assert.equal(room.data.hits[0].str, "OFFICE 101");

  // case-insensitive
  const ci = await call(client, "find_text", { sheet: KEY, q: "office" });
  assert.equal(ci.isError, false);
  assert.ok(ci.data.count > 0);

  // a region that excludes the hit finds nothing
  const missed = await call(client, "find_text", { sheet: KEY, q: "101", region: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  assert.equal(missed.isError, false);
  assert.equal(missed.data.count, 0);

  // limit caps hits but count still reports the true total
  const capped = await call(client, "find_text", { sheet: KEY, q: "0", limit: 1 });
  assert.equal(capped.isError, false);
  assert.equal(capped.data.hits.length, 1);
  assert.ok(capped.data.count >= capped.data.hits.length);
  if (capped.data.count > 1) assert.equal(capped.data.truncated, true);

  // schema's min(1) catches "" (see conformance.test.ts's -32602 sweep);
  // whitespace-only passes that and is caught here instead
  const blank = await call(client, "find_text", { sheet: KEY, q: "   " });
  assert.equal(blank.isError, true);
  assert.match(blank.data.error, /non-empty/);
});

test("edit_materials: add/remove/patch, minted-on-touch, all-or-nothing, undo restores verbatim", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  // add alone mints the condition — no shape needs to exist first
  const added = await call(client, "edit_materials", { condition: "CPT-1", add: [
    { name: "Adhesive", per: 250, basis: "area", unit: "gal" },
  ] });
  assert.equal(added.isError, false);
  assert.equal(added.data.condition_id.startsWith("cnd-"), true);
  assert.equal(added.data.materials.length, 1);
  const rowId = added.data.materials[0].id;
  assert.equal(added.data.materials[0].round, true, "default round:true");
  assert.equal(added.data.changed.added[0], rowId);

  // patch changes fields without touching id/basis
  const patched = await call(client, "edit_materials", { condition: "CPT-1", patch: [
    { id: rowId, fields: { per: 300, note: "verify TDS" } },
  ] });
  assert.equal(patched.isError, false);
  assert.equal(patched.data.materials[0].per, 300);
  assert.equal(patched.data.materials[0].note, "verify TDS");
  assert.equal(patched.data.materials.length, 1);

  // remove drops the row
  const removed = await call(client, "edit_materials", { condition: "CPT-1", remove: [rowId] });
  assert.equal(removed.isError, false);
  assert.equal(removed.data.materials.length, 0);

  // remove/patch on an unknown tag errors WITHOUT minting an empty condition
  const before = await call(client, "takeoff_summary");
  const condCountBefore = before.data.conditions.length;
  const badRemove = await call(client, "edit_materials", { condition: "NOPE-9", remove: ["mat-nope"] });
  assert.equal(badRemove.isError, true);
  assert.match(badRemove.data.error, /no material row/);
  const after = await call(client, "takeoff_summary");
  assert.equal(after.data.conditions.length, condCountBefore, "no empty condition minted by a failed call");

  // empty body errors
  const empty = await call(client, "edit_materials", { condition: "CPT-1" });
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /at least one of add, remove, patch/);

  // blank name on add errors before anything is written
  const blank = await call(client, "edit_materials", { condition: "CPT-1", add: [{ name: "  " }] });
  assert.equal(blank.isError, true);
  assert.match(blank.data.error, /name required/);

  // undo_last restores the whole materials array from before the last edit_materials call
  const readded = await call(client, "edit_materials", { condition: "CPT-1", add: [{ name: "Sealer", per: 400 }] });
  assert.equal(readded.data.materials.length, 1);
  const undone = await call(client, "undo_last", { n: 1 });
  assert.equal(undone.isError, false);
  assert.equal(undone.data.steps[0].op, "materials");
  assert.equal(undone.data.steps[0].shapes, 0);
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.isError, false);
  // materials is stripped from the lean summary reply by design — confirm via export_takeoff instead
  const exported = await call(client, "export_takeoff", {});
  const cond = exported.data.conditions.find((c: any) => c.finish_tag === "CPT-1");
  assert.equal(cond.materials.length, 0, "undo restored the pre-add state");
});

// ── annotations (#114) — the agent half of markup.condition_id (#112) ────────

test("annotate: attaches a note to a scope, resolves the tag back, and round-trips into the app payload", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const cloud = await call(client, "annotate", {
    sheet: KEY, type: "cloud", text: "verify substrate before install",
    rect: [[400, 900], [800, 1200]], condition: "CPT-1",
  });
  assert.equal(cloud.isError, false);
  assert.equal(cloud.data.condition, "CPT-1");            // minted on first touch
  assert.ok(cloud.data.condition_id);

  // a sheet note, deliberately unattached
  const note = await call(client, "annotate", { sheet: KEY, type: "text", text: "GC to confirm", at: [500, 500] });
  assert.equal(note.data.condition, "");
  assert.equal(note.data.condition_id, "");

  const all = await call(client, "list_annotations", {});
  assert.equal(all.data.count, 2);
  assert.equal(all.data.unattached, 1);                    // the text note
  // condition resolved for the caller — no join against conditions[] needed
  const c = all.data.annotations.find((a: any) => a.id === cloud.data.id);
  assert.equal(c.condition, "CPT-1");
  // coordinates come back in the SAME image-px frame they went in as
  assert.deepEqual(c.rect[0], [400, 900]);

  // filtering by condition excludes the unattached note
  const only = await call(client, "list_annotations", { condition: "CPT-1" });
  assert.equal(only.data.count, 1);
  assert.equal(only.data.annotations[0].id, cloud.data.id);

  // the export the app imports carries them — markups used to be hardcoded []
  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.markups.length, 2);
  const exported = payload.data.markups.find((m: any) => m.id === cloud.data.id);
  assert.equal(exported.condition_id, cloud.data.condition_id);
  assert.ok(exported.rect[0][0] > 0 && exported.rect[0][0] < 1, "stored normalized, like verts_norm");
});

test("link_annotation: attaches an orphan note, and detaches on an empty condition", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const note = await call(client, "annotate", { sheet: KEY, type: "text", text: "chase this", at: [300, 300] });

  const linked = await call(client, "link_annotation", { annotation_id: note.data.id, condition: "LVT-2" });
  assert.equal(linked.isError, false);
  assert.equal(linked.data.condition, "LVT-2");
  assert.equal((await call(client, "list_annotations", {})).data.unattached, 0);

  const off = await call(client, "link_annotation", { annotation_id: note.data.id, condition: "" });
  assert.equal(off.data.condition, "");
  assert.equal((await call(client, "list_annotations", {})).data.unattached, 1);

  // a bad id is a user error, not a crash
  const bad = await call(client, "link_annotation", { annotation_id: "mk-nope", condition: "LVT-2" });
  assert.equal(bad.isError, true);
});

test("annotate: a shape-less type mismatch is refused before anything is written", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const noRect = await call(client, "annotate", { sheet: KEY, type: "cloud", text: "x" });   // cloud needs rect
  assert.equal(noRect.isError, true);
  const noTarget = await call(client, "annotate", { sheet: KEY, type: "callout", text: "x", at: [10, 10] });
  assert.equal(noTarget.isError, true);
  assert.equal((await call(client, "list_annotations", {})).data.count, 0);   // nothing written
});

// dimension — the one annotation the scale gate applies to: it LABELS a real
// length, so an unscaled sheet refuses exactly like the measure tools, and a
// scaled one snapshots the measured feet onto the markup (len_ft) so the
// canvas and the marked set draw the label with no scale plumbing of their own.
test("annotate dimension: scale-gated, labels itself with the measured length, round-trips, burns into the marked set", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  // endpoints are required, like arrow
  const noEnds = await call(client, "annotate", { sheet: KEY, type: "dimension", from: [600, 400] });
  assert.equal(noEnds.isError, true);
  assert.match(noEnds.data.error, /dimension needs from.*and to/);

  // unscaled: the measure tools' exact refusal, and nothing is written
  const unscaled = await call(client, "annotate", { sheet: KEY, type: "dimension", from: [600, 400], to: [960, 400] });
  assert.equal(unscaled.isError, true);
  assert.equal(unscaled.data.error, `Set the scale for ${KEY} first — use set_scale (detected: 1/4" = 1'-0").`);
  assert.equal((await call(client, "list_annotations", {})).data.count, 0);

  // scaled: 360 px at 1/4" = 1'-0" (36 px per real foot) = exactly 10 LF
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const dim = await call(client, "annotate", { sheet: KEY, type: "dimension", from: [600, 400], to: [960, 400], text: "VIF", condition: "CPT-1" });
  assert.equal(dim.isError, false);
  assert.equal(dim.data.length_lf, 10);
  assert.equal(dim.data.condition, "CPT-1");

  // round-trip: endpoints come back in image px, the length rides along
  const listed = await call(client, "list_annotations", {});
  const ld = listed.data.annotations.find((m: any) => m.type === "dimension");
  assert.deepEqual(ld.from, [600, 400]);
  assert.deepEqual(ld.to, [960, 400]);
  assert.equal(ld.length_lf, 10);
  assert.equal(ld.text, "VIF");

  // the app payload carries it (normalized, len_ft on the markup)
  const payload = await call(client, "export_takeoff", {});
  const exported = payload.data.markups.find((m: any) => m.type === "dimension");
  assert.equal(exported.len_ft, 10);
  assert.ok(exported.from[0] > 0 && exported.from[0] < 1, "stored normalized, like arrow");

  // burns into the marked set (annotations alone mark a sheet)
  const dir = await mkdtemp(path.join(tmpdir(), "ot-dim-"));
  const out = path.join(dir, "dim.pdf");
  const pdf = await call(client, "export_marked_pdf", { path: out });
  assert.equal(pdf.isError, false);
  assert.equal(pdf.data.annotations_drawn, 1);
  assert.equal((await readFile(out)).subarray(0, 5).toString(), "%PDF-");
});

// ── symbol_sweep: one example instance → every placement, from the linework ──
// The fixture (test/fixtures/symbol-plan.pdf, scripts/make-symbol-fixture.mjs)
// pins exact counts: seed + 3 identical translations + 1 rotated + 1 mirrored
// + 1 perturbed near-miss (withheld) + 1 square-only decoy (ignored).
const SYMPLAN = fileURLToPath(new URL("./fixtures/symbol-plan.pdf", import.meta.url));
const SYMKEY = "symbol-plan.pdf";
// seed instance at PDF (100..134, 100..120) pt → image px, with margin
const SEED_RECT = [[196, 980], [272, 1028]];

test("symbol_sweep: exact counts on the fixture — matches, rotation/mirror flags, the withheld near-miss, the ignored decoy", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });
  // deliberately NO set_scale — the sweep and its EA commits are scale-free

  const r = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT });
  assert.equal(r.isError, false);
  assert.equal(r.data.found, 5, "3 identical + 1 rotated + 1 mirrored; seed and decoy never counted");
  assert.equal(r.data.seed.segments, 6);
  assert.equal(r.data.matches.filter((m: any) => m.rotation === 0 && !m.mirrored).length, 3);
  assert.equal(r.data.matches.filter((m: any) => m.rotation !== 0 && !m.mirrored).length, 1, "the rotated instance");
  assert.equal(r.data.matches.filter((m: any) => m.mirrored).length, 1, "the mirrored instance");
  assert.ok(r.data.matches.every((m: any) => m.score >= 0.92));

  // the near-miss is REPORTED, with its location and a reason — never silent
  assert.equal(r.data.withheld.length, 1);
  const w = r.data.withheld[0];
  assert.ok(w.score >= 0.75 && w.score < 0.92, `withheld band: ${w.score}`);
  assert.match(w.reason, /commit bar/);
  assert.ok(Math.abs(w.at[0] - 623.9) < 3 && Math.abs(w.at[1] - 564) < 3, "sits where the perturbed instance sits");

  // the seed's own location is diagnostics, never a match
  assert.ok(Math.abs(r.data.seed.center[0] - 223.9) < 2 && Math.abs(r.data.seed.center[1] - 1004) < 2);
  assert.ok(r.data.matches.every((m: any) => Math.hypot(m.at[0] - r.data.seed.center[0], m.at[1] - r.data.seed.center[1]) > 50));
  assert.equal(r.data.candidates.dropped, 0);
  assert.equal(r.data.warning, undefined);

  // orientation pinning: rotations/mirror off finds only the translations
  const pinned = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, rotations: false, mirror: false });
  assert.equal(pinned.data.found, 3);

  // determinism: same call, same reply
  const again = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT });
  assert.deepEqual(again.data, r.data);
});

test("symbol_sweep commit: match centers through the place_count path — one undo step, symbol_sweep provenance, withheld never committed", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });

  // commit without a condition is a contradiction, refused before any work
  const bare = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, commit: true });
  assert.equal(bare.isError, true);
  assert.match(bare.data.error, /needs a condition/);

  const r = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, commit: true, condition: "FD-1" });
  assert.equal(r.isError, false);
  assert.equal(r.data.committed, 5, "one count marker per MATCH");
  assert.equal(r.data.ea_total, 5);
  assert.equal(r.data.shape_ids.length, 5);
  assert.equal(r.data.withheld.length, 1, "the near-miss is still reported");

  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions[0].ea, 5, "withheld never reached the takeoff");

  // provenance: method, score, and transform ride every marker
  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.shapes.length, 5);
  for (const shp of payload.data.shapes) {
    assert.equal(shp.origin.method, "symbol_sweep");
    assert.equal(shp.origin.actor, "agent");
    assert.equal(shp.origin.reviewed, false);
    assert.ok(shp.origin.symbol.score >= 0.92, "the evidence that made it a commit");
    assert.equal(typeof shp.origin.symbol.rotation, "number");
    assert.equal(typeof shp.origin.symbol.mirrored, "boolean");
  }

  // the whole sweep is ONE undo step
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].op, "commit");
  assert.equal(undo.data.steps[0].tool, "symbol_sweep");
  assert.equal(undo.data.steps[0].shapes, 5);
  assert.equal(undo.data.shape_count, 0);
});

test("symbol_sweep refusals: empty marquee, marquee off the ink, and a loose rect are instructions, not crashes", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });

  // a marquee over blank paper names the fix
  const blank = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: [[1000, 100], [1100, 200]] });
  assert.equal(blank.isError, true);
  assert.match(blank.data.error, /fully inside the seed rect/);

  // a degenerate rect
  const degenerate = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: [[500, 500], [500, 500]] });
  assert.equal(degenerate.isError, true);
  assert.match(degenerate.data.error, /Empty seed rect/);

  // nothing above minted anything
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 0);
});

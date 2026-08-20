// Tool-layer tests over a real client/server pair on an in-memory transport —
// schemas, error surfaces, and the scale gate as an MCP client sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session, sanitizeApprovals } from "../src/session.ts";
import { openPdf, positionedText } from "../src/pdf.ts";
// the canvas's own tally — the same function the marked-set cover prints from
import { approvalTally } from "../../web/src/lib/approvals.js";
// the rules engine's own mask builder — the #207 test plants a synthetic
// linework mask in the session cache so candidate production is deterministic
// (the demo plan's rooms are clean rectangles with no islands to find)
import { buildMask } from "../../web/src/lib/oneclick.ts";

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
// delete_verdict takes a record id — same reasoning.
const NO_COORDS = new Set(["undo_last", "edit_materials", "edit_condition", "export_report", "export_marked_pdf", "link_annotation", "list_shapes", "derive_base", "import_takeoff", "delete_verdict", "duplicate_condition", "split_condition", "apply_rules"]);

test("tools/list: all forty tools, each described with the coordinate contract", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "annotate", "apply_rules", "cut_out", "delete_shape", "delete_verdict", "derive_base", "derive_transitions", "detect_rooms", "duplicate_condition", "edit_condition", "edit_materials", "edit_shape", "export_marked_pdf", "export_report",
    "export_takeoff", "find_schedule", "find_text", "import_takeoff",
    "link_annotation", "list_annotations", "list_shapes", "load_plan", "mark_verdict", "measure_line", "measure_polygon", "measure_surface", "one_click", "place_count",
    "read_sheet_text", "resolve_tag", "set_scale", "sheet_context", "sheet_graph", "sheet_info", "split_condition", "sweep_schedule_row", "symbol_sweep", "takeoff_summary", "undo_last", "view_sheet",
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
  assert.equal(room.data.area_sf, 287.77, "the standing VA truth, on a merged document (re-pinned for the sealed-engine wiring: this session now floods through floodAtSeed — feet-true seal radii, door-swing wedges, the minimum-passage rule — on a scale-pinned mask, the canvas's own arguments, instead of the raw floodRegion. 269.71 was the raw-path figure; the +0.90 SF net is two annexed door swings less a 3.9% min-passage trim, exactly what the canvas measures at this click. Parity is proven against the bench corpus goldens in parity.test.ts. RE-PINNED AGAIN 270.61 → 287.09 (+16.48 SF, +6.1%) for classifyOffsetAnnotationSegs: this room, like every room on this sheet, carries a hairline finish-tag ring drawn ~2 ft inside its walls with the P-tag boxes straddling it, and the flood used to stop on the ring and lose the perimeter band. The ring now classifies as annotation on pen evidence — heavier stroke alongside on one side, open floor on the other — and the room reads wall-to-wall through the moderate grow-but-verify tier. The canvas moves identically at this click; the web bench re-pinned patient-room-137 in the same change, 167.96 → 202.05 SF, with its own adjudication in corpus/va-finish-plan.json. RE-PINNED 287.09 -> 287.77 (+0.68 SF) for the in-swing door leaf: the wedge retry now offers a door's LEAF as its own opening, not just its arc, so a sector that sits INSIDE the room behind the open panel is reachable. Out-swing doors are untouched by construction — their leaf is not on the room's boundary. Zero web-bench probes lose area in the same change; elevator-e01 gains 0.80 SF the same way)");

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

// #207 — imported correction rules re-run through the canvas's own engine:
// one reviewed:false batch, per-rule disclosure, idempotent, undone whole.
// The mask is synthetic (planted in the session's cache — ensureMask returns
// it verbatim) because the demo plan's rooms hold no enclosed islands; the
// ENGINE's behavior against real masks is web/test/rules.test.ts's job, and
// this test owns the wiring: import hydration + remap, provenance, journal.
test("apply_rules: refuses without rules, re-runs an imported rule as one batch, idempotent, one undo step", async () => {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(session).connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);

  await call(client, "load_plan", { path: PLAN });
  const noRules = await call(client, "apply_rules", {});
  assert.equal(noRules.isError, true);
  assert.match(noRules.data.error, /import_takeoff/);

  await call(client, "set_scale", { sheet: KEY, upp: 0.1 });
  const s = session.sheet(KEY);
  // synthetic linework in the sheet's real px frame: one room, a closed
  // column island (40×40 px = 16 SF at upp 0.1), and an open box (no bottom
  // wall — connects to the field, must never propose)
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    x0, y0, x1, y0,  x1, y0, x1, y1,  x1, y1, x0, y1,  x0, y1, x0, y0,
  ];
  const segs = [
    ...rect(100, 100, 500, 700),
    ...rect(200, 300, 240, 340),
    300, 500, 340, 500,  300, 500, 300, 540,  340, 500, 340, 540,
  ];
  s.mask = buildMask(segs, s.widthPx, s.heightPx);

  const room = await call(client, "measure_polygon", { sheet: KEY,
    verts: [[100, 100], [500, 100], [500, 700], [100, 700]], condition: "CPT-1", role: "floor_area" });
  assert.equal(room.isError, false);

  // the rules ride a canvas file: tag identity remaps the file's condition id
  // onto this session's own CPT-1
  const dir = await mkdtemp(path.join(tmpdir(), "ot-rules-"));
  const rulesFile = path.join(dir, "taught.json");
  const mkRule = (id: string, extra: Record<string, unknown> = {}) => ({
    id, created_at: "2026-08-05T00:00:00Z", seed_shape_id: "shp-canvas-seed",
    seed_condition_id: "cnd-file-1", predicate: { kind: "enclosed_subpolygon_deduct", max_area_sf: 25 },
    label: `rule ${id}`, applied_to: [], active: true, ...extra,
  });
  await writeFile(rulesFile, JSON.stringify({
    schema: "opentakeoff.takeoff_canvas.v1",
    conditions: [{ id: "cnd-file-1", finish_tag: "CPT-1", color: "#888", fill: "#888", hatch: "none", multiplier: 1, waste_pct: 0, materials: [] },
                 { id: "cnd-file-2", finish_tag: "GHOST-9", color: "#888", fill: "#888", hatch: "none", multiplier: 1, waste_pct: 0, materials: [] }],
    shapes: [], markups: [], sheets: [],
    rules: [mkRule("rul-live"), mkRule("rul-off", { active: false }),
            mkRule("rul-ghost", { seed_condition_id: "cnd-file-2" })],
  }));
  const imp = await call(client, "import_takeoff", { path: rulesFile });
  assert.equal(imp.isError, false);
  assert.equal(imp.data.rules_imported, 3, "rules ride the file into the session");

  // GHOST-9's condition arrived via the merge, so its rule evaluates too —
  // deactivate the condition path honestly by removing it from the session
  session.conditions = session.conditions.filter((c) => c.finish_tag !== "GHOST-9");

  const run1 = await call(client, "apply_rules", { sheet: KEY });
  assert.equal(run1.isError, false);
  assert.equal(run1.data.committed, 1, "the column island, once");
  const live = run1.data.rules.find((r: any) => r.rule_id === "rul-live");
  assert.equal(live.produced, 1);
  assert.equal(live.condition, "CPT-1");
  assert.ok(Math.abs(live.deduct_sf - 16) < 2, `~16 SF column, got ${live.deduct_sf}`);
  assert.deepEqual(run1.data.skipped_rules.map((r: any) => [r.rule_id, r.reason]).sort(),
    [["rul-ghost", "condition_not_in_session"], ["rul-off", "inactive"]]);

  // provenance: the canvas's third actor, reviewed false, full citation
  const minted = session.shapes.find((x) => x.id === live.shape_ids[0])!;
  assert.equal(minted.measure_role, "deduct");
  assert.equal(minted.origin?.method, "rule_v1");
  assert.equal(minted.origin?.actor, "rule");
  assert.equal(minted.origin?.reviewed, false);
  assert.equal(minted.origin?.rule_id, "rul-live");
  assert.equal(minted.origin?.seed_shape_id, "shp-canvas-seed");
  assert.equal(minted.origin?.container_shape_id, room.data.shape_id);
  const rule = session.rules.find((r) => r.id === "rul-live")!;
  assert.deepEqual(rule.applied_to, live.shape_ids, "audit trail mirrors the canvas's Apply");

  // the deduct nets out of the summary through the same totals the canvas sums
  const sum1 = await call(client, "takeoff_summary");
  const cpt = sum1.data.conditions.find((c: any) => c.finish_tag === "CPT-1");
  assert.ok(cpt.floor_sf < room.data.area_sf, "deduct netted");

  // idempotent: the committed deduct covers its own island on the re-run
  const run2 = await call(client, "apply_rules", { sheet: KEY });
  assert.equal(run2.data.committed, 0, "re-run mints nothing");
  assert.match(run2.data.note, /idempotent/);

  // one undo step takes the whole batch back — and only the batch
  const before = session.shapes.length;
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].tool, "apply_rules");
  assert.equal(session.shapes.length, before - 1);
  assert.ok(session.shapes.some((x) => x.id === room.data.shape_id), "the room survives the undo");
});

// #206 — a real hole, reconciled the way the canvas cuts one: boolean
// subtract on the parent, compose without double-deducting, one undo step,
// and the canvas's delete semantics as the spec.
test("cut_out: real holes compose on the parent, refusals hold, delete reverts, parent delete orphans", async () => {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(session).connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);

  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, upp: 0.1 });
  // a clean 40×40 ft room: 1600 SF, 160 LF
  const room = await call(client, "measure_polygon", { sheet: KEY,
    verts: [[100, 100], [500, 100], [500, 500], [100, 500]], condition: "CPT-1", role: "floor_area" });
  const parentId = room.data.shape_id;
  assert.equal(room.data.area_sf, 1600);

  // refusals: unknown parent, non-floor parent, edge-crossing ring, and a cut
  // that would erase the parent outright — nothing commits on any of them
  const ghost = await call(client, "cut_out", { parent_shape_id: "shp-nope", verts: [[200, 200], [240, 200], [240, 240], [200, 240]] });
  assert.equal(ghost.isError, true);
  const overlay = await call(client, "measure_polygon", { sheet: KEY,
    verts: [[600, 600], [640, 600], [640, 640], [600, 640]], condition: "CPT-1", role: "deduct" });
  const notFloor = await call(client, "cut_out", { parent_shape_id: overlay.data.shape_id, verts: [[610, 610], [620, 610], [620, 620], [610, 620]] });
  assert.equal(notFloor.isError, true);
  assert.match(notFloor.data.error, /an area or clips a run/);
  const crossing = await call(client, "cut_out", { parent_shape_id: parentId, verts: [[450, 450], [550, 450], [550, 550], [450, 550]] });
  assert.equal(crossing.isError, true);
  assert.match(crossing.data.error, /not fully inside/);
  const erases = await call(client, "cut_out", { parent_shape_id: parentId, verts: [[100, 100], [500, 100], [500, 500], [100, 500]] });
  assert.equal(erases.isError, true);

  // the real cut: 4×4 ft column → parent nets 1584, hole ADDS perimeter
  const cut1 = await call(client, "cut_out", { parent_shape_id: parentId, verts: [[200, 200], [240, 200], [240, 240], [200, 240]] });
  assert.equal(cut1.isError, false);
  assert.equal(cut1.data.hole_sf, 16);
  assert.equal(cut1.data.parent_net.area_sf, 1584);
  assert.equal(cut1.data.parent_net.perimeter_lf, 176);
  assert.equal(cut1.data.holes, 1);
  const parent = session.shapes.find((x) => x.id === parentId)!;
  assert.equal(parent.verts_norm_holes?.length, 1);
  const deduct1 = session.shapes.find((x) => x.id === cut1.data.deduct_shape_id)!;
  assert.equal(deduct1.cuts_shape_id, parentId);
  assert.equal(deduct1.origin?.method, "cutout_v1");
  assert.equal(deduct1.origin?.reviewed, false);
  assert.ok(deduct1.origin?.parent_prev, "the pre-cut snapshot rides the deduct");

  // totals read the reconciled number ONCE — the reconciled deduct is skipped,
  // the legacy overlay deduct still subtracts arithmetically
  const sum = await call(client, "takeoff_summary");
  const cpt = sum.data.conditions.find((c: any) => c.finish_tag === "CPT-1");
  assert.equal(cpt.floor_sf, 1584 - overlay.data.area_sf);

  // an overlapping second cut never double-deducts: 16 SF ring, 4 SF already
  // inside the first hole → nets 12, and the two holes merge into one ring
  const cut2 = await call(client, "cut_out", { parent_shape_id: parentId, verts: [[220, 220], [260, 220], [260, 260], [220, 260]] });
  assert.equal(cut2.data.hole_sf, 12);
  assert.equal(cut2.data.parent_net.area_sf, 1572);

  // one undo step takes ONE cut back — parent and hole together
  await call(client, "undo_last", { n: 1 });
  assert.equal(session.shapes.find((x) => x.id === parentId)!.computed.area_sf, 1584);
  assert.equal(session.shapes.find((x) => x.id === cut2.data.deduct_shape_id), undefined);

  // edit_shape treats the pair as one geometry: outer-ring reshape and
  // deduct moves refuse; a label ride-along stays fine
  const editParent = await call(client, "edit_shape", { shape_id: parentId, verts: [[100, 100], [520, 100], [520, 500], [100, 500]] });
  assert.equal(editParent.isError, true);
  assert.match(editParent.data.error, /strand/);
  const editDeduct = await call(client, "edit_shape", { shape_id: cut1.data.deduct_shape_id, verts: [[210, 210], [250, 210], [250, 250], [210, 250]] });
  assert.equal(editDeduct.isError, true);
  const editLabel = await call(client, "edit_shape", { shape_id: cut1.data.deduct_shape_id, label: "column C4" });
  assert.equal(editLabel.isError, false);

  // canvas delete semantics, half 1: deleting the sole reconciled deduct
  // reverts the parent to its pristine ring
  const del1 = await call(client, "delete_shape", { shape_id: cut1.data.deduct_shape_id });
  assert.match(del1.data.note ?? "", /reverted/i);
  const restored = session.shapes.find((x) => x.id === parentId)!;
  assert.equal(restored.computed.area_sf, 1600);
  assert.equal(restored.verts_norm_holes, undefined);
  // and its undo puts the cut state back
  await call(client, "undo_last", { n: 1 });
  assert.equal(session.shapes.find((x) => x.id === parentId)!.computed.area_sf, 1584);
  assert.ok(session.shapes.some((x) => x.id === cut1.data.deduct_shape_id));

  // half 1b: one of SEVERAL cuts rebuilds from the pristine base minus the
  // survivors — delete the FIRST cut of two, the second's hole survives
  const cut3 = await call(client, "cut_out", { parent_shape_id: parentId, verts: [[300, 300], [340, 300], [340, 340], [300, 340]] });
  assert.equal(cut3.data.parent_net.area_sf, 1568);
  await call(client, "delete_shape", { shape_id: cut1.data.deduct_shape_id });
  const rebuilt = session.shapes.find((x) => x.id === parentId)!;
  assert.equal(rebuilt.computed.area_sf, 1584, "pristine 1600 minus the surviving 16 SF cut");
  assert.equal(rebuilt.verts_norm_holes?.length, 1);

  // canvas delete semantics, half 2: deleting the PARENT does not cascade —
  // the reconciled deduct orphans, disclosed, and totals ignore it
  const delParent = await call(client, "delete_shape", { shape_id: parentId });
  assert.match(delParent.data.note ?? "", /orphaned/);
  assert.ok(session.shapes.some((x) => x.id === cut3.data.deduct_shape_id), "the orphan stays, as on the canvas");
  const sumAfter = await call(client, "takeoff_summary");
  const cptAfter = sumAfter.data.conditions.find((c: any) => c.finish_tag === "CPT-1");
  assert.equal(cptAfter.floor_sf, -overlay.data.area_sf, "only the legacy overlay subtracts; the orphan is ignored");

  // reviewed parent: ink is never cut
  session.shapes.push({ ...structuredClone(session.shapes.find((x) => x.id === cut3.data.deduct_shape_id)!), id: "shp-ink", measure_role: "floor_area", cuts_shape_id: undefined, verts_norm: [[0.05, 0.05], [0.2, 0.05], [0.2, 0.2], [0.05, 0.2]], origin: { method: "manual", reviewed: true } });
  const inkCut = await call(client, "cut_out", { parent_shape_id: "shp-ink", verts: [[150, 150], [160, 150], [160, 160], [150, 160]] });
  assert.equal(inkCut.isError, true);
  assert.match(inkCut.data.error, /ink/);
  // final census: the legacy overlay, the orphaned reconciled deduct, and the
  // ink probe — every refusal along the way committed nothing
  assert.deepEqual(
    session.shapes.map((x) => x.id).sort(),
    [overlay.data.shape_id, cut3.data.deduct_shape_id, "shp-ink"].sort());
});

// Wall tile is a RUN, not a polygon — cut_out clips it (the bug: a deduct over
// a wall run used to land as an overlay whose SF came off the FLOOR total).
test("cut_out on an open run: clips the stretch, splits at a middle cut, refuses the misses — one undo step", async () => {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(session).connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, upp: 0.1 });
  // a 40-ft wall run at 8 ft tall → 40 LF, 320 SF
  const wall = await call(client, "measure_surface", { sheet: KEY,
    pts: [[100, 800], [500, 800]], condition: "WT-1", height_ft: 8 });
  const wallId = wall.data.shape_id;
  assert.equal(wall.data.length_lf, 40);
  assert.equal(wall.data.area_sf, 320);

  // a ring that misses the run refuses — nothing silently commits
  const miss = await call(client, "cut_out", { parent_shape_id: wallId, verts: [[100, 200], [140, 200], [140, 240], [100, 240]] });
  assert.equal(miss.isError, true);
  assert.match(miss.data.error, /does not cross/);

  // the real cut: 10 ft out of the MIDDLE → two runs, 15 LF each
  const cut = await call(client, "cut_out", { parent_shape_id: wallId, verts: [[250, 780], [350, 780], [350, 820], [250, 820]] });
  assert.equal(cut.isError, false);
  assert.equal(cut.data.deduct_shape_id, undefined, "a run mints NO deduct receipt — its SF would count against the floor");
  assert.equal(cut.data.pieces.length, 2);
  assert.deepEqual(cut.data.pieces.map((p: any) => p.lf), [15, 15]);
  assert.deepEqual(cut.data.pieces.map((p: any) => p.sf), [120, 120], "SF rides the surviving length: 15 LF x 8 ft");
  assert.equal(cut.data.removed_lf, 10);
  assert.equal(cut.data.removed_sf, 80);
  const far = session.shapes.find((x) => x.id === cut.data.pieces[1].shape_id)!;
  assert.equal(far.measure_role, "surface_area");
  assert.equal(far.height_ft, 8, "the far side carries the height that makes it a wall");
  assert.equal(far.condition_id, session.shapes.find((x) => x.id === wallId)!.condition_id);

  // totals move in the WALL bucket, not the floor
  const sum = await call(client, "takeoff_summary");
  const wt = sum.data.conditions.find((c: any) => c.finish_tag === "WT-1");
  assert.equal(wt.wall_sf, 240);
  assert.equal(wt.floor_sf, 0);

  // one undo_last puts the run back whole and unmints the far side
  await call(client, "undo_last", { n: 1 });
  assert.equal(session.shapes.find((x) => x.id === wallId)!.computed.area_sf, 320);
  assert.equal(session.shapes.find((x) => x.id === cut.data.pieces[1].shape_id), undefined);
  assert.deepEqual(session.shapes.map((x) => x.id), [wallId]);

  // a ring that swallows the run whole is a delete, and says so
  const all = await call(client, "cut_out", { parent_shape_id: wallId, verts: [[50, 700], [600, 700], [600, 900], [50, 900]] });
  assert.equal(all.isError, true);
  assert.match(all.data.error, /delete_shape/);
  assert.equal(session.shapes.length, 1, "every refusal committed nothing");
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

// #202 — where two finishes meet: butt joints commit, shared walls are questions.
test("derive_transitions: commits butt joints, withholds wall adjacency, refuses whole", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  const rooms = (await call(client, "list_shapes", { condition: "CPT-1" })).data.shapes;
  assert.ok(rooms.length >= 2, "the demo plan gives us rooms to work with");

  // reassign one room to a second finish so the two tags genuinely abut
  await call(client, "edit_shape", { shape_id: rooms[1].id, condition: "PT-1" });

  const r = await call(client, "derive_transitions", { condition_a: "CPT-1", condition_b: "PT-1", condition: "T-1" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.between, ["CPT-1", "PT-1"]);
  // whatever the demo geometry yields, the contract holds: committed LF is
  // butt-joint LF only, and withheld LF is never folded into the total
  assert.equal(r.data.committed, r.data.runs.length);
  assert.equal(r.data.total_lf, +r.data.runs.reduce((n: number, x: any) => n + x.length_lf, 0).toFixed(2));
  for (const w of r.data.withheld) {
    assert.equal(w.reason, "wall_separated");
    assert.ok(w.gap_in > 0, "a withheld run states the wall it measured");
    assert.equal(w.at.length, 2, "and a point to go look at");
  }
  const summary = await call(client, "takeoff_summary");
  const t1 = summary.data.conditions.find((c: any) => c.finish_tag === "T-1");
  if (r.data.committed) {
    assert.equal(t1.lf, r.data.total_lf, "committed transitions are the tag's LF");
    // provenance names both parents and the case — never a wall
    const payload = await call(client, "export_takeoff", {});
    const shp = payload.data.shapes.find((s: any) => s.id === r.data.runs[0].shape_id);
    assert.equal(shp.origin.derived.case, "butt");
    assert.deepEqual(shp.origin.derived.between, ["CPT-1", "PT-1"]);
    assert.equal(shp.origin.derived.between_shape_ids.length, 2);
    await call(client, "undo_last", { n: 1 });   // the whole sweep is one step
    const after = (await call(client, "takeoff_summary")).data.conditions.find((c: any) => c.finish_tag === "T-1");
    assert.ok(!after || after.lf === 0, "one undo removes the whole derivation");
  } else {
    assert.equal(t1, undefined, "nothing committed means no tag was minted with LF");
  }

  // refusals — all-or-nothing, before anything commits
  const sameTag = await call(client, "derive_transitions", { condition_a: "CPT-1", condition_b: "CPT-1", condition: "T-9" });
  assert.equal(sameTag.isError, true);
  assert.match(sameTag.data.error, /does not transition to itself/);
  const ontoSource = await call(client, "derive_transitions", { condition_a: "CPT-1", condition_b: "PT-1", condition: "CPT-1" });
  assert.equal(ontoSource.isError, true);
  assert.match(ontoSource.data.error, /OWN tag/);
  const unknown = await call(client, "derive_transitions", { condition_a: "CPT-1", condition_b: "NOPE-1", condition: "T-9" });
  assert.equal(unknown.isError, true);
  const t9 = (await call(client, "takeoff_summary")).data.conditions.find((c: any) => c.finish_tag === "T-9");
  assert.equal(t9, undefined, "refused calls committed nothing");
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
  // seeds flood clean: 7/19 -> 6/17, same contract, better boundaries), and
  // AGAIN for the sealed-engine session wiring (floodAtSeed on scale-pinned
  // masks — the canvas's own feet-true arguments — replacing the raw
  // floodRegion): 6 -> 5. The dropped room is 133, and the drop is the sealed
  // engine being HONEST: the raw flood only reached 133's floor by LEAKING
  // through its drawn tag box's pinhole (46.74 SF); sealing closes the box, the
  // snapped 4.62 SF box ring is no room, and the 5 SF plausibility floor
  // withholds it (withheld.implausible) instead of committing a tag box as a
  // room. 142 also corrects 285.96 -> 161.00 SF — the min-passage rule severs
  // a hairline conjunction the raw flood measured as one space — and 134A
  // gains its annexed door swing (78.93 -> 90.13 SF). Canvas parity is proven
  // against the bench corpus goldens in parity.test.ts.
  assert.equal(r.data.detected, 5);
  assert.ok(r.data.rooms.every((x: any) => typeof x.shape_id === "string" && typeof x.condition === "string"),
    "every reported room committed, each carrying the tag it committed under");
  const tags = new Set(r.data.rooms.map((x: any) => x.condition));
  assert.equal(tags.size, 5, `distinct finishes from distinct rows — the whole point (5 rooms, 5 rows after the sealed-wiring re-pin). Got: ${[...tags].join(",")}`);
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

  // provenance: the schedule verdict and its citation ride every commit —
  // and the sealed engine's account (confidence + factors) stamps centrally
  // in commit(), so every flood-committed shape ships scored
  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.shapes.length, 5);
  for (const shp of payload.data.shapes) {
    assert.equal(shp.origin.assignment.source, "schedule");
    assert.ok(shp.origin.assignment.room_tag, "the room tag that resolved");
    assert.equal(shp.origin.assignment.surface, "FLOOR");
    assert.equal(shp.origin.assignment.schedule_sheet, `${FKEY}#2`, "the citation names the schedule sheet");
    assert.ok(typeof shp.origin.confidence === "number" && shp.origin.confidence > 0 && shp.origin.confidence <= 1,
      "the trace-confidence score rides origin on every flood commit (RFC #60 item D)");
  }
  const inv = await call(client, "list_shapes", {});
  assert.ok(inv.data.shapes.every((x: any) => x.assignment === "schedule"), "list_shapes carries the flat verdict");
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 5);
  assert.equal(summary.data.conditions.reduce((n: number, c: any) => n + c.shape_count, 0), 5);

  // mutual exclusion: both finish-tag sources at once is a contradiction,
  // refused before any flooding — nothing minted, nothing committed
  const both = await call(client, "detect_rooms", { sheet: FKEY, condition: "CPT-1", assign_from_schedule: true });
  assert.equal(both.isError, true);
  assert.match(both.data.error, /at most one of/);
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 5, "the refusal changed nothing");

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

// #259, reported by @FrankAtGHub: the seed legitimately matches things you do
// not mean, because drafting reuses one generic shape for several devices —
// his case was a wall-mounted data outlet drawn as a plain triangle whose
// flush-floor sibling is the SAME triangle inside a square. The fixture has
// that exact structure already: the square-only decoy is a bare shape, and
// every drain instance is that same square PLUS a diagonal and a stub. So
// seeding the decoy matches all seven, and excluding one drain teaches the
// sweep what "plus" means.
const SQUARE_RECT = [[892, 272], [948, 332]];

test("symbol_sweep exclude: a counter-example rejects the lookalikes, discloses every rejection, and never rejects on thin evidence (#259)", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });

  // the bare square is a real sub-shape of the drain, so it matches every
  // instance that contains one — the ambiguity the issue is about
  const bare = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SQUARE_RECT });
  assert.equal(bare.isError, false);
  assert.equal(bare.data.seed.segments, 4, "the square alone");
  assert.equal(bare.data.found, 7, "every drain contains this square; the decoy is the seed and is excluded");
  assert.equal(bare.data.rejected, undefined, "no counter-example, no rejections");

  // one drain marqueed as "not this one" — the caller never says WHY
  const r = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SQUARE_RECT, exclude: [SEED_RECT] });
  assert.equal(r.isError, false);
  // the rect's own contents chose the mechanic: extra contained linework
  assert.deepEqual(r.data.negatives, [{ mode: "shape", segments: 2, center: [220, 1004] }], "the diagonal and the stub — the drain minus the square");

  assert.equal(r.data.found, 1, "six drains rejected; only the perturbed instance survives");
  assert.equal(r.data.rejected.length, 6);
  assert.ok(r.data.rejected.every((x: any) => x.by === 1 && x.mode === "shape" && x.evidence === 1));
  assert.match(r.data.rejected[0].reason, /explains this placement at least as well/);
  // rejections are placements, addressable on the sheet — reinstating one by
  // hand is place_count at its `at`, no re-run
  assert.ok(r.data.rejected.every((x: any) => Array.isArray(x.at) && x.at.length === 2));
  // and they are NOT quietly folded into matches
  assert.ok(r.data.matches.every((m: any) => !r.data.rejected.some((x: any) => x.at[0] === m.at[0] && x.at[1] === m.at[1])));

  // the survivor is the instance whose extra linework genuinely differs: its
  // diagonal is perturbed past tolerance, so only the stub is found and the
  // evidence bar is not met. Under-reject rather than falsely reject.
  assert.deepEqual(r.data.matches.map((m: any) => m.at), [[620, 564]]);

  // rotation and mirroring do not smuggle an excluded instance back in: a
  // square maps onto itself eight ways, so the negative is read under the
  // seed's own symmetry group rather than one arbitrary frame
  assert.ok(r.data.rejected.some((x: any) => x.at[0] === 820 && x.at[1] === 764), "the rotated drain");
  assert.ok(r.data.rejected.some((x: any) => x.at[0] === 220 && x.at[1] === 564), "the mirrored drain");

  // an exclusion is never counted, and commit never commits one
  const c = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SQUARE_RECT, exclude: [SEED_RECT], commit: true, condition: "SQ-1" });
  assert.equal(c.data.committed, 1);
  assert.equal(c.data.ea_total, 1);

  // determinism
  const again = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SQUARE_RECT, exclude: [SEED_RECT] });
  assert.deepEqual(again.data, r.data);
});

test("symbol_sweep exclude: a counter-example that separates nothing is refused, not silently ignored (#259)", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });

  // the same symbol with nothing extra — it would reject every real match
  const same = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, exclude: [[[396, 980], [472, 1028]]] });
  assert.equal(same.isError, true);
  assert.match(same.data.error, /separates it from the seed/);

  // empty paper — no instance of the seed to subtract from
  const empty = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, exclude: [[[1000, 1100], [1080, 1180]]] });
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /must be an instance of what you seeded/);
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

// ── verdict marks (#176) — the agent half of the approval family ─────────────
// The estimator's APPROVED ring is minted only by the canvas's Approve tool;
// mark_verdict mints the AGENT diamond and is structurally incapable of
// anything else. These tests pin the whole loop: mint (shape + sheet point),
// anchor choice, inventory, exact undo, the ink refusal, the marked-set
// tally, and the export/import round-trip through the canvas's own load gate.

test("mark_verdict: shape and sheet-point mints, anchors, inventory, and the exactly-one-target refusals", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  // exactly one target — none, or both, is a refusal that writes nothing
  const none = await call(client, "mark_verdict", {});
  assert.equal(none.isError, true);
  assert.match(none.data.error, /exactly one target/);
  const square = await call(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [300, 100], [300, 300], [100, 300]], condition: "CPT-1" });
  const both = await call(client, "mark_verdict", { shape_id: square.data.shape_id, sheet: KEY, at: [50, 50] });
  assert.equal(both.isError, true);
  assert.match(both.data.error, /exactly one target/);
  const half = await call(client, "mark_verdict", { sheet: KEY });
  assert.equal(half.isError, true);
  assert.match(half.data.error, /BOTH sheet and at/);
  assert.equal((await call(client, "list_annotations", {})).data.verdict_count, 0, "the refusals minted nothing");

  // shape mode: a closed room anchors at its area centroid, condition resolved
  const onShape = await call(client, "mark_verdict", { shape_id: square.data.shape_id, text: "traced against A-101 walls" });
  assert.equal(onShape.isError, false);
  assert.match(onShape.data.id, /^apr-/);
  assert.equal(onShape.data.actor, "agent");
  assert.equal(onShape.data.sheet, KEY);
  assert.deepEqual(onShape.data.at, [200, 200], "a square's area centroid");
  assert.equal(onShape.data.shape_id, square.data.shape_id);
  assert.equal(onShape.data.condition, "CPT-1");
  assert.equal(onShape.data.text, "traced against A-101 walls");
  assert.ok(onShape.data.ts, "mint time stamped");

  // one mark per shape — a second diamond stacked on the same anchor is
  // invisible duplication, refused with the re-mark path named
  const dup = await call(client, "mark_verdict", { shape_id: square.data.shape_id });
  assert.equal(dup.isError, true);
  assert.match(dup.data.error, /already carries an agent verdict/);

  // an open run anchors at its on-path midpoint; a count marker at its point
  const line = await call(client, "measure_line", { sheet: KEY, pts: [[0, 0], [360, 0], [360, 360]], condition: "RB-1" });
  const onLine = await call(client, "mark_verdict", { shape_id: line.data.shape_id });
  assert.deepEqual(onLine.data.at, [360, 0], "half the run's length lands at the elbow");
  const ea = await call(client, "place_count", { sheet: KEY, points: [[500, 500]], condition: "TR-1" });
  const onCount = await call(client, "mark_verdict", { shape_id: ea.data.shape_ids[0] });
  assert.deepEqual(onCount.data.at, [500, 500], "a count marker is its own anchor");

  // sheet-point mode: no shape, no condition — a mark about the paper
  const onSheet = await call(client, "mark_verdict", { sheet: KEY, at: [1200, 800], text: "sheet checked for scope gaps" });
  assert.equal(onSheet.isError, false);
  assert.deepEqual(onSheet.data.at, [1200, 800]);
  assert.equal(onSheet.data.shape_id, undefined);
  assert.equal(onSheet.data.condition, undefined);

  // a bad shape id is a user error naming the inventory
  const badId = await call(client, "mark_verdict", { shape_id: "shp-nope" });
  assert.equal(badId.isError, true);
  assert.match(badId.data.error, /list_shapes/);

  // the inventory: all four, actors stated, condition filter reaches through
  // the target shape, sheet-point marks drop out of any condition filter
  const all = await call(client, "list_annotations", {});
  assert.equal(all.data.verdict_count, 4);
  assert.ok(all.data.verdicts.every((v: any) => v.actor === "agent"));
  const byCond = await call(client, "list_annotations", { condition: "CPT-1" });
  assert.equal(byCond.data.verdict_count, 1);
  assert.equal(byCond.data.verdicts[0].id, onShape.data.id);
  assert.equal(byCond.data.verdicts[0].condition, "CPT-1");
  const bySheet = await call(client, "list_annotations", { sheet: KEY });
  assert.equal(bySheet.data.verdict_count, 4);

  // a verdict touches no quantity — the takeoff is exactly what was measured
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.reduce((n: number, c: any) => n + c.shape_count, 0), 3);
});

test("mark_verdict is structurally agent-only: an injected actor is discarded, and the export says agent on every record", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  // the tool has no actor input, so an injected one is stripped by the input
  // schema — the reply AND the stored record still say agent
  const forged = await call(client, "mark_verdict", { sheet: KEY, at: [600, 600], actor: "estimator" });
  assert.equal(forged.isError, false);
  assert.equal(forged.data.actor, "agent", "there is no path to the estimator's seal");

  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.approvals.length, 1);
  assert.equal(payload.data.approvals[0].actor, "agent");

  // and at the session boundary: markVerdict takes no actor at all, while the
  // estimator's ink — arriving only by import — refuses the agent's delete
  const session = new Session();
  await session.loadPlan(PLAN);
  session.approvals.push({ id: "apr-human", actor: "estimator", sheet_id: KEY, at: [0.5, 0.5] });
  assert.throws(() => session.deleteVerdict("apr-human"), /human ink/);
  assert.equal(session.approvals.length, 1, "the refusal lifted nothing");
});

test("delete_verdict + undo_last: a lift is journaled with its exact inverse, and a mint undoes clean", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const a = await call(client, "mark_verdict", { sheet: KEY, at: [100, 100], text: "first" });
  const b = await call(client, "mark_verdict", { sheet: KEY, at: [200, 200], text: "second" });

  // unknown id names the inventory
  const nope = await call(client, "delete_verdict", { verdict_id: "apr-nope" });
  assert.equal(nope.isError, true);
  assert.match(nope.data.error, /verdicts\[\]/);

  // lift the FIRST record, then undo — it comes back at its original index,
  // id and ts included (the pure apply's restore contract)
  const del = await call(client, "delete_verdict", { verdict_id: a.data.id });
  assert.equal(del.isError, false);
  assert.deepEqual(del.data, { deleted: a.data.id, verdicts_remaining: 1 });
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].op, "approval");
  assert.equal(undo.data.steps[0].tool, "delete_verdict");
  const restored = await call(client, "list_annotations", {});
  assert.deepEqual(restored.data.verdicts.map((v: any) => v.id), [a.data.id, b.data.id], "re-seated at its original index, order intact");

  // undoing past the delete takes back the mints too, newest first
  const back2 = await call(client, "undo_last", { n: 2 });
  assert.deepEqual(back2.data.steps.map((s: any) => s.tool), ["mark_verdict", "mark_verdict"]);
  assert.equal((await call(client, "list_annotations", {})).data.verdict_count, 0);
});

test("verdicts in the marked set: glyphs drawn, sheet marked, and the cover tallies the ink/pencil split", async () => {
  const client = await pair();
  const dir = await mkdtemp(path.join(tmpdir(), "ot-verdict-"));
  const tmpPlan = path.join(dir, "sample-plan.pdf");
  await copyFile(PLAN, tmpPlan);
  await call(client, "load_plan", { path: tmpPlan });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const room = await call(client, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1" });
  await call(client, "mark_verdict", { shape_id: room.data.shape_id });
  await call(client, "mark_verdict", { sheet: KEY, at: [1200, 300] });

  const pdf = await call(client, "export_marked_pdf", {});
  assert.equal(pdf.isError, false);
  assert.equal(pdf.data.approvals_drawn, 2);
  assert.equal(pdf.data.pages, 2);

  // the cover states the split in so many words — read it back off the page
  const doc = await openPdf(pdf.data.path);
  const cover = positionedText(await doc.page(1)).map((t) => t.str).join(" ");
  assert.match(cover, /Approval stamps: 0 estimator-approved · 2 agent-marked/);
  await doc.destroy();

  // a verdict alone marks its sheet — a sheet-point mark before any takeoff
  // still exports (the markedset seal-only rule, reachable from here)
  const solo = await pair();
  await call(solo, "load_plan", { path: tmpPlan });
  await call(solo, "mark_verdict", { sheet: KEY, at: [500, 500] });
  const soloPdf = await call(solo, "export_marked_pdf", { path: path.join(dir, "solo.pdf") });
  assert.equal(soloPdf.isError, false);
  assert.equal(soloPdf.data.sheets_marked, 1);
  assert.equal(soloPdf.data.approvals_drawn, 1);
  assert.equal((await readFile(soloPdf.data.path)).subarray(0, 5).toString(), "%PDF-");
});

test("verdicts round-trip: export_takeoff → import_takeoff (wholesale and merge), through the canvas's own load gate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ot-verdict-rt-"));
  const exported = path.join(dir, "takeoff.json");

  // session A: trace, mark, export
  const a = await pair();
  await call(a, "load_plan", { path: PLAN });
  await call(a, "set_scale", { sheet: KEY, use_detected: true });
  const room = await call(a, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1" });
  const v1 = await call(a, "mark_verdict", { shape_id: room.data.shape_id, text: "checked" });
  const v2 = await call(a, "mark_verdict", { sheet: KEY, at: [1000, 1000] });
  const payload = await call(a, "export_takeoff", { path: exported });
  assert.equal(payload.data.approvals.length, 2);

  // the exact records the file carries pass the canvas hydrate's load gate
  // (sanitizeApprovals IS what TakeoffCanvas runs on a.approvals) — so what
  // this server mints is what the app renders as the AGENT diamond
  assert.equal(sanitizeApprovals(payload.data.approvals).length, 2, "every record survives the canvas load gate");
  assert.deepEqual(approvalTally(payload.data.approvals), { estimator: 0, agent: 2 }, "the cover tally the canvas would print");

  // fresh session B: wholesale adoption
  const b = await pair();
  await call(b, "load_plan", { path: PLAN });
  const r = await call(b, "import_takeoff", { path: exported });
  assert.equal(r.data.replaced, true);
  const listed = await call(b, "list_annotations", {});
  assert.equal(listed.data.verdict_count, 2);
  assert.deepEqual(listed.data.verdicts.map((v: any) => v.id).sort(), [v1.data.id, v2.data.id].sort());
  const rt = listed.data.verdicts.find((v: any) => v.id === v1.data.id);
  assert.equal(rt.text, "checked", "the note rides the round-trip");
  assert.deepEqual(rt.at, v1.data.at, "the anchor survives normalized storage exactly");
  // and imported marks are live records here: agent marks lift, undo re-seats
  await call(b, "delete_verdict", { verdict_id: v2.data.id });
  assert.equal((await call(b, "list_annotations", {})).data.verdict_count, 1);

  // worked session C: merge keeps its own marks and adds the file's (new ids
  // append, re-import would skip them — the markup rule)
  const c = await pair();
  await call(c, "load_plan", { path: PLAN });
  await call(c, "set_scale", { sheet: KEY, use_detected: true });
  await call(c, "measure_polygon", { sheet: KEY, verts: [[100, 100], [200, 100], [200, 200], [100, 200]], condition: "CPT-1" });
  const own = await call(c, "mark_verdict", { sheet: KEY, at: [50, 50] });
  const m = await call(c, "import_takeoff", { path: exported });
  assert.equal(m.data.replaced, false);
  const merged = await call(c, "list_annotations", {});
  assert.equal(merged.data.verdict_count, 3, "own mark kept, both imported marks added");
  assert.ok(merged.data.verdicts.some((v: any) => v.id === own.data.id));
  const again = await call(c, "import_takeoff", { path: exported });
  assert.equal(again.isError, false);
  assert.equal((await call(c, "list_annotations", {})).data.verdict_count, 3, "re-import is idempotent for verdicts too");
});

// ── symbol_sweep phase 2: set-wide sweeps, plan-only counting ────────────────
// The fixture (test/fixtures/symbol-set.pdf, scripts/make-symbol-fixture.mjs):
// four sheets — FLOOR PLAN (4 drains: 3 plain + 1 rotated), FINISH PLAN
// (2 drains: 1 plain + 1 mirrored), DETAILS (1 drain — the seed source),
// FINISH SCHEDULE (1 reference drain). Plan-only counting = exactly 6.
const SYMSET = fileURLToPath(new URL("./fixtures/symbol-set.pdf", import.meta.url));
// the detail sheet's drain at PDF pt (300..334, 300..320) → image px, with margin
const DETAIL_SEED = [[590, 574], [678, 634]];
const stripTimings = (r: any) => ({ ...r, sheets: r.sheets.map(({ elapsed_ms, ...p }: any) => p) });
/** #186: a detail-seeded sweep needs both ends' scales stated before it will
 * run. The fixture draws its detail at PLAN size, so one label everywhere is
 * the truthful statement here and the ratio comes out 1 — every count below is
 * the phase-2 number, unchanged. */
const scaleSet = async (client: any): Promise<void> => {
  for (const sheet of ["symbol-set.pdf", "symbol-set.pdf#2", "symbol-set.pdf#3"]) {
    await call(client, "set_scale", { sheet, upp: 0.25 });
  }
};

test("symbol_sweep scope 'set': detail-seeded, counts plan sheets only, per-sheet results, deterministic", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });
  await scaleSet(client);

  const r = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.equal(r.isError, false);
  assert.equal(r.data.scope, "set");
  assert.equal(r.data.found, 6, "4 on the floor plan + 2 on the finish plan — the detail and schedule instances never count");
  assert.deepEqual(r.data.seed.sheet, "symbol-set.pdf#3");
  assert.equal(r.data.seed.role, "detail", "the seed sheet's role is stated");
  assert.equal(r.data.matches, undefined, "set scope reports per sheet, not as one flat pile");

  // per-sheet results in load order, each with its own cap accounting and wall-clock
  assert.deepEqual(r.data.sheets.map((p: any) => [p.sheet, p.found]), [["symbol-set.pdf", 4], ["symbol-set.pdf#2", 2]]);
  for (const p of r.data.sheets) {
    assert.equal(p.candidates.dropped, 0);
    assert.ok(typeof p.elapsed_ms === "number" && p.elapsed_ms >= 0, `${p.sheet} reports wall-clock`);
  }
  assert.equal(r.data.sheets[0].matches.filter((m: any) => m.rotation !== 0).length, 1, "the rotated instance");
  assert.equal(r.data.sheets[1].matches.filter((m: any) => m.mirrored).length, 1, "the mirrored instance");

  // every excluded sheet is disclosed with role and reason — the seed's own
  // sheet is named as the source, and the schedule's reference drawing never counts
  const skipped = Object.fromEntries(r.data.skipped.map((s: any) => [s.sheet, s]));
  assert.equal(skipped["symbol-set.pdf#3"].role, "detail");
  assert.match(skipped["symbol-set.pdf#3"].reason, /seed source/);
  assert.equal(skipped["symbol-set.pdf#4"].role, "schedule");
  assert.match(skipped["symbol-set.pdf#4"].reason, /reference drawings/);

  // deterministic up to wall-clock: same call, same counts, same order
  const again = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.deepEqual(stripTimings(again.data), stripTimings(r.data));

  // a plan-role seed sheet participates in the counting with its seed suppressed
  const fromPlan = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf", seed_rect: [[230, 314], [318, 374]], scope: "set" });
  assert.equal(fromPlan.isError, false);
  assert.equal(fromPlan.data.seed.role, "plan");
  assert.equal(fromPlan.data.found, 5, "6 instances minus the seed itself");
  assert.ok(fromPlan.data.sheets.some((p: any) => p.sheet === "symbol-set.pdf"), "the seed's own sheet is swept, not skipped");
});

test("symbol_sweep scope 'set' commit: one undo step across sheets, seed-source provenance on every marker", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });
  await scaleSet(client);

  const r = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set", commit: true, condition: "FD-1" });
  assert.equal(r.isError, false);
  assert.equal(r.data.committed, 6);
  assert.equal(r.data.ea_total, 6);

  // the markers landed on their own sheets
  const p1 = await call(client, "list_shapes", { sheet: "symbol-set.pdf" });
  const p2 = await call(client, "list_shapes", { sheet: "symbol-set.pdf#2" });
  assert.equal(p1.data.count, 4);
  assert.equal(p2.data.count, 2);

  // provenance: method, per-marker score/transform, AND the seed source —
  // fingerprinted on the detail sheet, its role recorded
  const payload = await call(client, "export_takeoff", {});
  assert.equal(payload.data.shapes.length, 6);
  for (const shp of payload.data.shapes) {
    assert.equal(shp.origin.method, "symbol_sweep");
    assert.ok(shp.origin.symbol.score >= 0.92);
    assert.deepEqual(shp.origin.symbol.seed, { source: "detail_sheet", sheet: "symbol-set.pdf#3", role: "detail" });
    assert.deepEqual(shp.origin.assignment, { source: "asserted" }, "the caller chose the tag — asserted, not schedule");
  }

  // the whole set-wide sweep is ONE undo step
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].tool, "symbol_sweep");
  assert.equal(undo.data.steps[0].shapes, 6);
  assert.equal(undo.data.shape_count, 0);
});

// ── #186: the size ratio across sheets ──────────────────────────────────────

test("#186 symbol_sweep: a detail seed with no scale REFUSES — reason, fix, and the trap named", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });

  const r = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.equal(r.isError, true, "sweeping blind would report a confident zero on an enlarged detail");
  assert.match(r.data.error, /drawn at its own enlarged scale/);
  assert.match(r.data.error, /set_scale/, "the fix is named");
  assert.match(r.data.error, /confident zero/, "and so is what it is protecting against");

  // scale only the seed — the plan targets are still unstated, so it still refuses
  await call(client, "set_scale", { sheet: "symbol-set.pdf#3", upp: 0.25 });
  const half = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.equal(half.isError, true);
  assert.match(half.data.error, /symbol-set\.pdf/, "the sheets still missing a scale are named");

  // both ends stated → it runs, and at this fixture's true ratio of 1 the
  // phase-2 count is untouched
  await scaleSet(client);
  const ok = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.equal(ok.isError, false);
  assert.equal(ok.data.found, 6);
  assert.ok(ok.data.sheets.every((p: any) => p.scaled === undefined && p.scale_assumed === undefined),
    "a ratio of 1 is the reply it always was — no new keys");
});

test("#186 symbol_sweep: an enlarged detail is found at the stated ratio, and says what the resize cost", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });
  // the detail sheet declares itself drawn 4× the plans: upp is real feet per
  // image px, so a LARGER drawing is a SMALLER upp
  await call(client, "set_scale", { sheet: "symbol-set.pdf", upp: 0.25 });
  await call(client, "set_scale", { sheet: "symbol-set.pdf#2", upp: 0.25 });
  await call(client, "set_scale", { sheet: "symbol-set.pdf#3", upp: 0.0625 });

  const r = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf#3", seed_rect: DETAIL_SEED, scope: "set" });
  assert.equal(r.isError, false);
  for (const p of r.data.sheets) {
    assert.equal(p.scaled.ratio, 0.25, `${p.sheet} resized by the sheets' own scales`);
    assert.equal(p.scaled.tol_px, 2, "shrinking never loosens the endpoint test");
    assert.ok(p.scaled.footprint_px > 0);
  }
  assert.match(r.data.note, /Size ratio applied from the sheets' own scales/);
  // the fixture's detail is NOT actually drawn 4× — so a stated 4× finds
  // nothing, which is the honest answer to a false statement about the sheets
  assert.equal(r.data.found, 0, "a wrong stated ratio produces an empty sweep, not a wrong count");
});

test("#186 symbol_sweep: a plan-seeded sweep with no scales still runs, and discloses the assumption", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });

  // plan → plan is the ordinary case: one set's plan sheets share a scale
  // nearly always, so this stays permissive rather than demanding set_scale
  const r = await call(client, "symbol_sweep", { sheet: "symbol-set.pdf", seed_rect: [[230, 314], [318, 374]], scope: "set" });
  assert.equal(r.isError, false);
  assert.equal(r.data.found, 5, "unchanged: 6 instances minus the seed itself");
  const other = r.data.sheets.find((p: any) => p.sheet === "symbol-set.pdf#2");
  assert.match(other.scale_assumed, /swept at 1:1/, "the cross-sheet leg says it assumed same-size drafting");
  assert.equal(r.data.sheets.find((p: any) => p.sheet === "symbol-set.pdf").scale_assumed, undefined,
    "a sheet swept against ITSELF has a known ratio of 1 — nothing was assumed");
  assert.match(r.data.note, /Swept at 1:1 on symbol-set\.pdf#2/);
});

test("symbol_sweep scope 'set' refusal: no text layer means roles are unknown — refused, never guessed", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMPLAN });   // the phase-1 fixture has no text layer
  const r = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT, scope: "set" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /sheet ROLES are unknown .* scope 'sheet'/);
  // sheet scope still works on the same set
  const single = await call(client, "symbol_sweep", { sheet: SYMKEY, seed_rect: SEED_RECT });
  assert.equal(single.isError, false);
  assert.equal(single.data.found, 5);
});

// ── sweep_schedule_row: mint the condition from the row, count where geometry
// and tag agree ──────────────────────────────────────────────────────────────
// Fixture truth for T1: 5 tagged markers on plan sheets (3 + 2), 1 marker
// tagged T2 (excluded), 1 untagged marker (withheld), 1 bare "T1" text with
// no marker (text_only), 1 T1 marker on the DETAILS sheet (never swept).
test("sweep_schedule_row: row citation, corroborated anchor, text-corroborated counting, full disclosure", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });

  const r = await call(client, "sweep_schedule_row", { tag: "T1" });
  assert.equal(r.isError, false);

  // the row is the cited source, cells included
  assert.equal(r.data.row.sheet, "symbol-set.pdf#4");
  assert.equal(r.data.row.cells.MATERIAL, "TRANSITION");
  assert.match(r.data.row.citation.text, /FINISH SCHEDULE row T1/);

  // the anchor: fingerprinted at a drawn occurrence, corroborated at another
  assert.equal(r.data.anchor.sheet, "symbol-set.pdf");
  assert.equal(r.data.anchor.corroborated, true);
  assert.equal(r.data.anchor.segments, 4, "the marker bubble's linework, not the text");
  assert.equal(r.data.anchor.occurrences, 6, "drawn occurrences across plan sheets only — the detail sheet's does not count");

  // the honest count: geometry AND tag agree
  assert.equal(r.data.found, 5);
  assert.deepEqual(r.data.sheets.map((p: any) => [p.sheet, p.found]), [["symbol-set.pdf", 3], ["symbol-set.pdf#2", 2]]);
  assert.ok(r.data.sheets[0].matches.every((m: any) => m.tag_at.x1 > m.tag_at.x0), "every counted match carries its tag-text evidence bbox");

  // full disclosure of everything that did NOT count, each with its story
  const p1 = r.data.sheets[0];
  assert.equal(p1.excluded.length, 1, "the same bubble shape tagged T2 belongs to T2");
  assert.equal(p1.excluded[0].tag, "T2");
  assert.equal(p1.withheld.length, 1, "the untagged marker is a question, not a count");
  assert.match(p1.withheld[0].reason, /carries no "T1" tag/);
  assert.equal(p1.text_only.length, 1, "the tag drawn with no marker is disclosed, never counted");

  // non-plan sheets are excluded and say so
  const skipped = Object.fromEntries(r.data.skipped.map((s: any) => [s.sheet, s.role]));
  assert.deepEqual(skipped, { "symbol-set.pdf#3": "detail", "symbol-set.pdf#4": "schedule" });

  // read mode committed nothing
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 0);
});

test("sweep_schedule_row commit: condition minted FROM the row, schedule provenance + row citation, one undo step", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });

  const r = await call(client, "sweep_schedule_row", { tag: "T1", commit: true });
  assert.equal(r.isError, false);
  assert.equal(r.data.committed, 5);
  assert.equal(r.data.condition, "T1", "the condition IS the row's key");
  assert.equal(r.data.ea_total, 5);

  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 1);
  assert.equal(summary.data.conditions[0].finish_tag, "T1");
  assert.equal(summary.data.conditions[0].ea, 5, "excluded/withheld/text_only never reached the takeoff");

  const payload = await call(client, "export_takeoff", {});
  for (const shp of payload.data.shapes) {
    assert.equal(shp.origin.method, "symbol_sweep");
    assert.deepEqual(shp.origin.assignment, { source: "schedule", schedule_sheet: "symbol-set.pdf#4" }, "the tag came from the schedule, and the record says so");
    assert.equal(shp.origin.symbol.seed.source, "schedule_row");
    assert.deepEqual(shp.origin.symbol.seed.row, { sheet: "symbol-set.pdf#4", key: "T1", table: "FINISH SCHEDULE" });
  }
  const inv = await call(client, "list_shapes", {});
  assert.ok(inv.data.shapes.every((x: any) => x.assignment === "schedule"));

  // one undo step for the whole set-wide sweep
  const undo = await call(client, "undo_last", { n: 1 });
  assert.equal(undo.data.steps[0].tool, "sweep_schedule_row");
  assert.equal(undo.data.steps[0].shapes, 5);
  assert.equal(undo.data.shape_count, 0);
});

test("sweep_schedule_row refusals: unanchorable row, unknown row, ambiguous key — reasons and fixes, nothing minted", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: SYMSET });

  // T9 exists as a row but its tag is drawn on no plan sheet — a fingerprint
  // is never guessed from text alone
  const t9 = await call(client, "sweep_schedule_row", { tag: "T9" });
  assert.equal(t9.isError, true);
  assert.match(t9.data.error, /cannot be geometrically anchored/);
  assert.match(t9.data.error, /never guessed from text alone/);
  assert.match(t9.data.error, /symbol_sweep/, "the refusal names the fallback");

  // an unknown key names what WAS found
  const zz = await call(client, "sweep_schedule_row", { tag: "ZZ" });
  assert.equal(zz.isError, true);
  assert.match(zz.data.error, /No schedule row "ZZ" .* finish on symbol-set\.pdf#4 \(3 rows\)/);

  // the same key defined in two tables (the fixture merged in twice under a
  // second name) is ambiguous — refused, never a coin flip
  const dir = await mkdtemp(path.join(tmpdir(), "ot-rowsweep-"));
  const twin = path.join(dir, "symbol-set-addendum.pdf");
  await copyFile(SYMSET, twin);
  await call(client, "load_plan", { path: twin, merge: true });
  const dup = await call(client, "sweep_schedule_row", { tag: "T1" });
  assert.equal(dup.isError, true);
  assert.match(dup.data.error, /Ambiguous: 2 schedule rows/);

  // none of the refusals minted anything
  assert.equal((await call(client, "takeoff_summary")).data.conditions.length, 0);
});


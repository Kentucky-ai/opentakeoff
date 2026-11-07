// Trade suites over the wire (src/suites.ts): hidden until opened, the opener's
// catalog and division routing, the refusal that names the opener, and each
// suite tool end to end on the bundled sample plan at a round scale
// (upp 0.1 → 10 image px = 1 ft), so every expected number is worked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { TOOL_NAMES } from "../src/staging.ts";
import { SUITE_TOOL_NAMES, preopenedSuites } from "../src/suites.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function pair(opts: { suites?: string[] | "all"; stagedTools?: boolean } = {}) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session(), { suites: opts.suites ?? [], stagedTools: opts.stagedTools ?? false });
  await server.connect(st);
  const client = new Client({ name: "suite-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data: any;
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { isError: !!res.isError, data };
}

async function ready(client: Client) {
  await call(client, "load_plan", { path: PLAN });
  const s = await call(client, "set_scale", { sheet: KEY, upp: 0.1 });
  assert.equal(s.isError, false, JSON.stringify(s.data));
}

const near = (a: number, b: number, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const row = (summary: any, tag: string) => summary.conditions.find((c: any) => c.finish_tag === tag);

test("suites: a default build lists open_suite and hides every suite tool", async () => {
  const client = await pair();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES]);
  assert.ok(names.includes("open_suite"));
  for (const t of SUITE_TOOL_NAMES) assert.ok(!names.includes(t), `${t} hidden until opened`);
});

test("suites: open_suite with no arguments is the catalog; its description carries one line per suite", async () => {
  const client = await pair();
  const tool = (await client.listTools()).tools.find((t) => t.name === "open_suite")!;
  for (const id of ["roofing", "siding", "soffit_fascia", "glazing", "plumbing", "electrical", "finishes", "doors"]) {
    assert.match(tool.description!, new RegExp(`- ${id} \\(Div`));
  }
  const r = await call(client, "open_suite");
  assert.equal(r.isError, false);
  assert.equal(r.data.catalog.length, 8);
  assert.deepEqual(r.data.opened, []);
});

test("suites: opening a suite enables only its tools and returns its method; division opens a set", async () => {
  const client = await pair();
  const r = await call(client, "open_suite", { suite: "roofing" });
  assert.deepEqual(r.data.tools_enabled, ["roof_takeoff"]);
  assert.match(r.data.suites[0].method, /roof_takeoff/);
  let names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("roof_takeoff"));
  assert.ok(!names.includes("siding_takeoff") && !names.includes("electrical_rollup"));

  const again = await call(client, "open_suite", { suite: "roofing" });
  assert.deepEqual(again.data.tools_enabled, [], "idempotent");

  const div = await call(client, "open_suite", { division: "07" });
  assert.deepEqual(div.data.opened, ["roofing", "siding", "soffit_fascia"]);
  assert.deepEqual(div.data.tools_enabled.sort(), ["siding_takeoff", "soffit_takeoff"]);
  names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("plumbing_rollup"));

  const bad = await call(client, "open_suite", { division: "05" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /No suite answers to division/);
});

test("suites: calling a closed suite tool names its suite and the opener", async () => {
  const client = await pair();
  let text = "";
  try {
    const res: any = await client.callTool({ name: "roof_takeoff", arguments: { pitch: "6/12" } });
    text = res.content?.[0]?.text ?? "";
  } catch (e) { text = (e as Error).message; }
  assert.match(text, /Roofing suite.*open_suite \{suite:"roofing"\}/);
});

test("suites: pre-opened by option or OPENTAKEOFF_MCP_SUITES", async () => {
  const client = await pair({ suites: ["glazing"] });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("glazing_takeoff") && !names.includes("roof_takeoff"));
  assert.deepEqual(preopenedSuites("all").length, 8);
  const prev = process.env.OPENTAKEOFF_MCP_SUITES;
  process.env.OPENTAKEOFF_MCP_SUITES = "plumbing, nonsense";
  try { assert.deepEqual(preopenedSuites(), ["plumbing"]); } finally {
    if (prev === undefined) delete process.env.OPENTAKEOFF_MCP_SUITES; else process.env.OPENTAKEOFF_MCP_SUITES = prev;
  }
});

test("suites: staged exposure keeps open_suite in setup and the suite tools hidden", async () => {
  const client = await pair({ stagedTools: true });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("open_suite") && names.includes("open_tool_stage"));
  for (const t of SUITE_TOOL_NAMES) assert.ok(!names.includes(t));
});

test("roof_takeoff: a 40 × 25 gable at 6/12 — true totals, accessories, idempotent, one undo", async () => {
  const client = await pair({ suites: ["roofing", "soffit_fascia"] });
  await ready(client);
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 100, 500, 350), condition: "RF-FIELD" });   // 40 × 25 = 1000 SF plan
  for (const y of [100, 350]) await call(client, "measure_line", { sheet: KEY, pts: [[100, y], [500, y]], condition: "RF-EAVE" });  // 2 × 40
  for (const x of [100, 500]) await call(client, "measure_line", { sheet: KEY, pts: [[x, 100], [x, 350]], condition: "RF-RAKE" });  // 2 × 25 plan
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 225], [500, 225]], condition: "RF-RIDGE" });  // 40

  const refused = await call(client, "roof_takeoff", { pitch: "steep" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /Cannot read pitch/);

  const r = await call(client, "roof_takeoff", { pitch: "6/12", ice_water: { eave_ft: 3 } });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  near(r.data.plan_sf, 1000);
  near(r.data.sloped_sf, 1118.03);
  assert.equal(r.data.waste_pct, 10);                 // gable: no hips or valleys
  near(r.data.edges_true_lf.rake, 55.9);              // 50 × 1.11803
  near(r.data.drip_edge_lf, 135.9);                   // 80 + 55.9
  near(r.data.ridge_cap_lf, 40);
  near(r.data.ice_water_sf, 240);                     // 80 × 3
  assert.equal(r.data.committed, 7);                  // drip 2 eave + 2 rake, starter 2, cap 1
  assert.equal(r.data.undo_steps, 3);                 // field knobs, rake multiplier, the commit

  const sum = (await call(client, "takeoff_summary")).data;
  near(row(sum, "RF-FIELD").floor_sf, 1118.03);      // the slope factor rides the condition
  near(row(sum, "RF-RAKE").lf, 55.9);
  near(row(sum, "RF-DRIP").lf, 135.9);
  near(row(sum, "RF-STARTER").lf, 80);
  near(row(sum, "RF-CAP").lf, 40);

  const again = await call(client, "roof_takeoff", { pitch: "6/12" });
  assert.equal(again.data.committed, 0, "re-run skips runs it already derived");
  near(again.data.sloped_sf, 1118.03, 0.02);         // plan area read from the shapes, not the multiplied total

  // soffit off the same edges: 12" eave and rake soffit at 6/12
  const s = await call(client, "soffit_takeoff", { overhang_in: 12, rake_overhang_in: 12, pitch: "6/12", vent: { attic_sf: 1000, ratio: 300 } });
  assert.equal(s.isError, false, JSON.stringify(s.data));
  near(s.data.eave_soffit_sf, 80);
  near(s.data.rake_soffit_sf, 55.9);
  near(s.data.fascia_lf, 135.9);
  near(s.data.vent.intake_nfa_in2, 240);              // 1000/300 × 144 × 0.5
  const sum2 = (await call(client, "takeoff_summary")).data;
  near(row(sum2, "SF-SOFFIT").wall_sf, 135.9);        // surface shapes: run × depth
  near(row(sum2, "SF-FASCIA").lf, 135.9);

  // undo the soffit call (commit + waste), then the second roof call (field + rake), then the first (3)
  await call(client, "undo_last", { n: 2 + again.data.undo_steps + 3 });
  const sum3 = (await call(client, "takeoff_summary")).data;
  near(row(sum3, "RF-FIELD").floor_sf, 1000);
  assert.equal(row(sum3, "RF-FIELD").multiplier, 1);
  assert.ok(!row(sum3, "RF-DRIP") || row(sum3, "RF-DRIP").lf === 0, "accessory runs undone");
});

test("siding_takeoff: wall, window deduct, door traced separately — net, trim, door-cut starter", async () => {
  const client = await pair({ suites: ["siding"] });
  await ready(client);
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 600, 400, 700), condition: "SD-WALL" });                  // 30 × 10
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(300, 630, 330, 670), condition: "SD-WALL", role: "deduct" });  // window 3 × 4
  const door = await call(client, "measure_polygon", { sheet: KEY, verts: rect(200, 630, 230, 700), condition: "SD-OPEN" });     // door 3 × 7
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 600], [100, 700]], condition: "SD-OSC" });                       // 10 ft corner

  const r = await call(client, "siding_takeoff", { door_openings: [door.data.shape_id], exposure_in: 8, piece_length_ft: 12 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  near(r.data.gross_sf, 300);
  near(r.data.openings_sf, 33);
  near(r.data.net_sf, 267);
  near(r.data.opening_trim_lf, 31);                  // window 14 + door 17
  near(r.data.starter_lf, 27);                       // 30 less the door
  near(r.data.outside_corner_lf, 10);
  assert.equal(r.data.pieces, 37);
  assert.equal(r.data.committed, 5);                 // door deduct copy, 2 trim paths, 2 starter runs

  const sum = (await call(client, "takeoff_summary")).data;
  near(row(sum, "SD-WALL").floor_sf, 267);           // the estimate is net
  near(row(sum, "SD-TRIM").lf, 31);
  near(row(sum, "SD-STARTER").lf, 27);

  const again = await call(client, "siding_takeoff", { door_openings: [door.data.shape_id] });
  near(again.data.net_sf, 267, 0.02);                // the copied deduct is not counted twice
  assert.equal(again.data.committed, 0);

  const bad = await call(client, "siding_takeoff", { door_openings: ["shp_nope"] });
  assert.equal(bad.isError, true);
});

test("glazing_takeoff: 12 × 8 storefront, 3 × 2 grid — lites, glass, mullion lines", async () => {
  const client = await pair({ suites: ["glazing"] });
  await ready(client);
  const f = await call(client, "measure_polygon", { sheet: KEY, verts: rect(600, 100, 720, 180), condition: "GL-SF1" });
  const r = await call(client, "glazing_takeoff", { condition: "GL-SF1", grid: [{ shape_id: f.data.shape_id, bays: 3, rows: 2 }] });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.totals.lites, 6);
  near(r.data.totals.glass_sf, 85);
  near(r.data.totals.vertical_mullion_lf, 16);
  near(r.data.totals.horizontal_mullion_lf, 12);
  near(r.data.totals.sealant_lf, 80);
  assert.equal(r.data.committed, 3);
  const sum = (await call(client, "takeoff_summary")).data;
  near(row(sum, "GL-MULLION").lf, 28);
});

test("electrical_rollup and plumbing_rollup write material rows once, update on re-run", async () => {
  const client = await pair({ suites: ["electrical", "plumbing"] });
  await ready(client);
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 900], [1100, 900]], condition: "E-BR" });            // 100 ft
  await call(client, "place_count", { sheet: KEY, points: [[150, 950], [250, 950], [350, 950]], condition: "E-DUP" });
  const e = await call(client, "electrical_rollup", { runs: [{ condition: "E-BR", conductors: 3 }], devices: ["E-DUP"] });
  assert.equal(e.isError, false, JSON.stringify(e.data));
  near(e.data.runs[0].wire_lf, 330);
  assert.equal(e.data.totals.boxes, 3);
  assert.equal(e.data.undo_steps, 2);

  const report = async () => (await call(client, "export_report")).data;
  let rep = await report();
  const mats = (tag: string) => rep.conditions.find((c: any) => c.finish_tag === tag).materials;
  const wire = mats("E-BR").find((m: any) => m.name.startsWith("Wire"));
  near(wire.qty, 330);
  assert.equal(mats("E-BR").find((m: any) => m.name === "Conduit couplings").qty, 10);
  assert.equal(mats("E-DUP").find((m: any) => m.name === "Device box").qty, 3);

  await call(client, "electrical_rollup", { runs: [{ condition: "E-BR", conductors: 4 }], devices: ["E-DUP"] });
  rep = await report();
  assert.equal(mats("E-BR").filter((m: any) => m.name.startsWith("Wire")).length, 2, "a different conductor count is its own row");
  assert.equal(mats("E-BR").filter((m: any) => m.name === "Conduit couplings").length, 1, "same row updated, never duplicated");

  await call(client, "measure_line", { sheet: KEY, pts: [[100, 1000], [1050, 1000]], condition: "P-CW-3/4" });     // 95 ft
  await call(client, "place_count", { sheet: KEY, points: [[150, 1050], [250, 1050], [350, 1050]], condition: "P-LAV1" });
  const p = await call(client, "plumbing_rollup", {
    fixtures: [{ condition: "P-LAV1", schedule_qty: 4 }],
    pipes: [{ condition: "P-CW-3/4", hanger_every_ft: 8, insulate: true }],
  });
  assert.equal(p.isError, false, JSON.stringify(p.data));
  assert.equal(p.data.fixtures[0].status, "mismatch");
  assert.equal(p.data.fixtures[0].carried, 3);
  assert.equal(p.data.needs_you.length, 1);
  assert.equal(p.data.pipes[0].hangers, 12);
  rep = await report();
  assert.equal(mats("P-CW-3/4").find((m: any) => m.name === "Pipe hangers").qty, 12);

  const missing = await call(client, "plumbing_rollup", { pipes: [{ condition: "P-NOPE" }] });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /No pipe condition/);
});

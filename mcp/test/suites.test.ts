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
  assert.match(refused.data.error, /2%/);
  assert.match(refused.data.error, /22\.5 deg/);
  assert.match(refused.data.error, /1:48/);
  assert.match(refused.data.error, /1\/4:12/);

  // Pitch printed as percent, degrees, or ratio reads in report mode
  const rPct = await call(client, "roof_takeoff", { pitch: "2%", apply: false });
  assert.equal(rPct.isError, false);
  assert.equal(rPct.data.pitch, "0.24/12");
  near(rPct.data.slope_factor, 1.0002);

  const rDeg = await call(client, "roof_takeoff", { pitch: "22.5 deg", apply: false });
  assert.equal(rDeg.isError, false);
  assert.equal(rDeg.data.pitch, "4.97/12");

  const rRatio = await call(client, "roof_takeoff", { pitch: "1:48", apply: false });
  assert.equal(rRatio.isError, false);
  assert.equal(rRatio.data.pitch, "0.25/12");
  assert.equal(rRatio.data.pitch_as_given, "1:48");   // the reply shows the pitch as passed

  const rFracRatio = await call(client, "roof_takeoff", { pitch: "1/4:12", apply: false });
  assert.equal(rFracRatio.isError, false);
  assert.equal(rFracRatio.data.pitch, "0.25/12");

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

test("suite tools in metric (#620): the same roof in m² and m, the soffit depth in mm, other-system names refused", async () => {
  const client = await pair({ suites: ["roofing", "soffit_fascia", "plumbing"] });
  await ready(client);
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 100, 500, 350), condition: "RF-FIELD" });   // 40 × 25 ft
  for (const y of [100, 350]) await call(client, "measure_line", { sheet: KEY, pts: [[100, y], [500, y]], condition: "RF-EAVE" });
  for (const x of [100, 500]) await call(client, "measure_line", { sheet: KEY, pts: [[x, 100], [x, 350]], condition: "RF-RAKE" });

  const imperial = await call(client, "roof_takeoff", { pitch: "6/12", apply: false });
  assert.equal(imperial.data.units, "imperial");
  near(imperial.data.sloped_sf, 1118.03);
  assert.ok("squares" in imperial.data);

  const metric = await call(client, "roof_takeoff", { pitch: "6/12", apply: false, units: "metric", ice_water: { eave_m: 0.9 } });
  assert.equal(metric.isError, false, JSON.stringify(metric.data));
  assert.equal(metric.data.units, "metric");
  near(metric.data.sloped_m2, 103.87);                        // 1118.03 SF
  near(metric.data.edges_true_m.rake, 17.04);                 // 55.9 LF
  near(metric.data.ice_water_m2, 21.95);                      // 80 LF of eave × 0.9 m
  for (const k of ["sloped_sf", "squares", "squares_with_waste", "edges_true_lf"]) assert.ok(!(k in metric.data), `${k} is not in a metric reply`);

  const wrongWay = await call(client, "roof_takeoff", { pitch: "6/12", apply: false, units: "metric", ice_water: { eave_ft: 3 } });
  assert.equal(wrongWay.isError, true);
  assert.match(wrongWay.data.error, /ice_water\.eave_ft is imperial; with units "metric" pass ice_water\.eave_m/);
  const otherWay = await call(client, "soffit_takeoff", { overhang_mm: 305, apply: false });
  assert.equal(otherWay.isError, true);
  assert.match(otherWay.data.error, /overhang_mm is metric; pass units: "metric"/);

  // 305 mm is 12.008 in: the same soffit to the reply's rounding
  const inches = await call(client, "soffit_takeoff", { overhang_in: 12, apply: false });
  const mm = await call(client, "soffit_takeoff", { overhang_mm: 305, apply: false, units: "metric" });
  assert.equal(mm.isError, false, JSON.stringify(mm.data));
  near(mm.data.eave_soffit_m2, inches.data.eave_soffit_sf * 0.09290304, 0.01);
  near(mm.data.fascia_m, inches.data.fascia_lf * 0.3048, 0.01);
  near(mm.data.overhang_mm, 305, 0.01);

  // a pipe run in metric: the hint names the metric argument, and the rows' notes the caller's units
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 400], [400, 400]], condition: "PL-CW" });   // 30 ft
  const noHangers = await call(client, "plumbing_rollup", { pipes: [{ condition: "PL-CW" }], apply: false, units: "metric" });
  assert.ok(noHangers.data.needs_you.concat(noHangers.data.not_figured ?? []).some((t: string) => /hanger_every_m/.test(t)), JSON.stringify(noHangers.data));
  const pipes = await call(client, "plumbing_rollup", { pipes: [{ condition: "PL-CW", hanger_every_m: 3, fittings_per_100_m: 10 }], units: "metric" });
  assert.equal(pipes.isError, false, JSON.stringify(pipes.data));
  near(pipes.data.pipes[0].m, 9.14);                          // 30 ft
  near(pipes.data.pipes[0].fittings_per_100_m, 10, 0.01);
  const notes = (await call(client, "export_report")).data.conditions.find((c: any) => c.finish_tag === "PL-CW").materials.map((m: any) => m.note);
  assert.ok(notes.includes("1 per 3 m (plumbing_rollup)") && notes.includes("10 per 100 m (plumbing_rollup)"), JSON.stringify(notes));

  // pipe tags that end like a unit are the caller's names: kept in the runs and in the hints, while the argument a hint names turns metric
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 450], [400, 450]], condition: "cw_lf" });
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 500], [400, 500]], condition: "p-hw_lf" });
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 550], [400, 550]], condition: "pl.gas_lf" });
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 600], [400, 600]], condition: "pl" });   // listed first, and the start of pl.gas_lf
  const lowerPipe = await call(client, "plumbing_rollup", { pipes: [{ condition: "pl" }, { condition: "cw_lf" }, { condition: "p-hw_lf" }, { condition: "pl.gas_lf" }], apply: false, units: "metric" });
  assert.deepEqual(lowerPipe.data.pipes.map((p: any) => p.tag), ["pl", "cw_lf", "p-hw_lf", "pl.gas_lf"]);
  for (const tag of ["pl", "cw_lf", "p-hw_lf", "pl.gas_lf"]) {
    assert.ok((lowerPipe.data.not_figured ?? []).includes(`${tag}: hangers (pass hanger_every_m from the spec)`), JSON.stringify(lowerPipe.data));
  }
});

test("suite tools in metric (#620): siding, glazing, electrical and the soffit vent; tags stay as named", async () => {
  const client = await pair({ suites: ["roofing", "siding", "soffit_fascia", "glazing", "electrical"] });
  await ready(client);

  // siding: 8" and 12' exactly, so the pieces match the imperial test's 37
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 600, 400, 700), condition: "SD-WALL" });                  // 30 × 10
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(300, 630, 330, 670), condition: "SD-WALL", role: "deduct" });  // window 3 × 4
  const door = await call(client, "measure_polygon", { sheet: KEY, verts: rect(200, 630, 230, 700), condition: "SD-OPEN" });     // door 3 × 7
  const sd = await call(client, "siding_takeoff", { door_openings: [door.data.shape_id], exposure_mm: 203.2, piece_length_m: 3.6576, apply: false, units: "metric" });
  assert.equal(sd.isError, false, JSON.stringify(sd.data));
  near(sd.data.net_m2, 24.81);                                // 267 SF
  near(sd.data.order_m2, 27.29);                              // 293.7 SF
  near(sd.data.openings.find((o: any) => o.sides === 4).m2, 1.11);   // the 12 SF window
  assert.equal(sd.data.pieces, 37);
  assert.equal(sd.data.piece, "203.2 mm reveal × 3.6576 m piece, waste included");
  for (const k of ["squares", "order_squares", "net_sf"]) assert.ok(!(k in sd.data), `${k} is not in a metric reply`);

  // glazing: a 12 × 8 ft frame, 3 × 2 lites; 63.5 mm is 2.5 in, giving 44.67" × 44.25" lites
  const f = await call(client, "measure_polygon", { sheet: KEY, verts: rect(600, 100, 720, 180), condition: "GL-SF1" });
  const grid = [{ shape_id: f.data.shape_id, bays: 3, rows: 2 }];
  const gl = await call(client, "glazing_takeoff", { condition: "GL-SF1", grid, sightline_mm: 63.5, apply: false, units: "metric" });
  assert.equal(gl.isError, false, JSON.stringify(gl.data));
  assert.equal(gl.data.openings[0].lite_dlo, "1135 mm × 1124 mm");
  near(gl.data.openings[0].width_m, 3.66);                    // 12 ft
  near(gl.data.totals.glass_m2, 7.65);                        // 82.35 SF
  const glDefault = await call(client, "glazing_takeoff", { condition: "GL-SF1", grid, apply: false, units: "metric" });
  assert.equal(glDefault.data.openings[0].lite_dlo, "1151 mm × 1143 mm");   // the 2 in default: 45.33" × 45"

  // electrical: a 100 ft run, 3 devices, 2 fixtures
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 900], [1100, 900]], condition: "E-BR" });
  await call(client, "place_count", { sheet: KEY, points: [[150, 950], [250, 950], [350, 950]], condition: "E-DUP" });
  await call(client, "place_count", { sheet: KEY, points: [[150, 850], [250, 850]], condition: "E-LT1" });
  const ei = await call(client, "electrical_rollup", { runs: [{ condition: "E-BR" }], fixtures: [{ condition: "E-LT1" }], apply: false });
  assert.deepEqual([ei.data.fixtures[0].whip_ft, ei.data.fixtures[0].whip_lf, ei.data.totals.couplings, ei.data.totals.straps], [6, 12, 10, 10], "imperial defaults");
  const em = await call(client, "electrical_rollup", {
    runs: [{ condition: "E-BR" }], devices: ["E-DUP"], fixtures: [{ condition: "E-LT1", whip_m: 2 }], coupling_every_m: 3, units: "metric",
  });
  assert.equal(em.isError, false, JSON.stringify(em.data));
  assert.equal(em.data.fixtures[0].whip_m, 2);                // each, as given
  assert.equal(em.data.fixtures[0].whip_total_m, 4);          // both fixtures
  assert.equal(em.data.totals.whip_total_m, 4);
  near(em.data.runs[0].conduit_m, 30.48);
  near(em.data.runs[0].wire_m, 100.58);                       // 330 LF
  assert.equal(em.data.runs[0].couplings, 11);                // 30.48 / 3, up
  assert.equal(em.data.runs[0].straps, 10);                   // the 10 ft default
  const rows = (await call(client, "export_report")).data.conditions;
  const notes = (tag: string) => rows.find((c: any) => c.finish_tag === tag).materials.map((m: any) => m.note).sort();
  assert.deepEqual(notes("E-BR"), ["1 per 3 m (electrical_rollup)", "1 per 3.05 m (electrical_rollup)", "conduit length × 3 × 1.1 slack (electrical_rollup)"]);
  assert.deepEqual(notes("E-LT1"), ["2 m per fixture (electrical_rollup)"]);

  // soffit vent: 92.90304 m² is 1000 SF, so 480 in² at 1/300, half at the soffit;
  // 8466.67 mm² per m is 4 in² per LF, so 240 / 4 = 60 LF vented
  for (const y of [100, 350]) await call(client, "measure_line", { sheet: KEY, pts: [[100, y], [500, y]], condition: "RF-EAVE" });
  const sv = await call(client, "soffit_takeoff", { overhang_mm: 305, apply: false, units: "metric", vent: { attic_m2: 92.90304, ratio: 300, nfa_mm2_per_m: 8466.67 } });
  assert.equal(sv.isError, false, JSON.stringify(sv.data));
  near(sv.data.vent.attic_m2, 92.9);
  near(sv.data.vent.required_nfa_mm2, 309676.8, 1);           // 480 in²
  near(sv.data.vent.intake_nfa_mm2, 154838.4, 1);             // 240 in²
  near(sv.data.vent.vented_soffit_m, 18.29);                  // 60 LF
  const misplaced = await call(client, "soffit_takeoff", { overhang_mm: 305, apply: false, units: "metric", attic_m2: 90, vent: { ratio: 300 } });
  assert.equal(misplaced.isError, true);
  assert.match(misplaced.data.error, /^vent needs attic_m2 or an attic_condition with floor area\. Not soffit_takeoff arguments, so ignored: attic_m2\.$/);

  // condition tags are the caller's names: one that ends like a unit is not renamed, the slope factors set on
  // them are not converted, and a tag that is also the start of an argument name ("valley") leaves the hint whole
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 100, 500, 350), condition: "roof_sf" });
  await call(client, "measure_line", { sheet: KEY, pts: [[300, 100], [300, 225]], condition: "valley" });
  const lower = await call(client, "roof_takeoff", { pitch: "6/12", field: "roof_sf", valley: "valley", units: "metric" });
  assert.equal(lower.isError, false, JSON.stringify(lower.data));
  assert.deepEqual(lower.data.multipliers_set, { roof_sf: 1.118034, valley: 1.06066 });   // 6/12: √1.25 and √1.125
  assert.ok(lower.data.not_figured.includes("ice & water in valleys (pass ice_water.valley_m)"), JSON.stringify(lower.data.not_figured));
  // nor a tag that is the argument's own last part
  await call(client, "measure_line", { sheet: KEY, pts: [[400, 100], [400, 225]], condition: "valley_ft" });
  const sameName = await call(client, "roof_takeoff", { pitch: "6/12", field: "roof_sf", valley: "valley_ft", units: "metric" });
  assert.ok("valley_ft" in sameName.data.multipliers_set, JSON.stringify(sameName.data.multipliers_set));
  assert.ok(sameName.data.not_figured.includes("ice & water in valleys (pass ice_water.valley_m)"), JSON.stringify(sameName.data.not_figured));
});

test("suite tools name the arguments they ignore (#620)", async () => {
  const client = await pair({ suites: ["roofing", "plumbing"] });
  await ready(client);
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 100, 500, 350), condition: "RF-FIELD" });
  const r = await call(client, "roof_takeoff", { pitch: "6/12", apply: false, unit: "metric", ice_water: { eave_feet: 3 } });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual([...r.data.unknown_args].sort(), ["ice_water.eave_feet", "unit"]);
  assert.match(r.data.next, /^Not roof_takeoff arguments, so ignored: (?=.*\bunit\b)(?=.*ice_water\.eave_feet)/);
  assert.equal(r.data.units, "imperial");
  const clean = await call(client, "roof_takeoff", { pitch: "6/12", apply: false });
  assert.ok(!("unknown_args" in clean.data));
  const proto = await call(client, "roof_takeoff", { pitch: "6/12", apply: false, constructor: 1 });
  assert.deepEqual(proto.data.unknown_args, ["constructor"], "a name every object inherits is still not an argument");

  // inside a list: an unknown key is named with its index, and a metric name without units is refused there too
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 400], [400, 400]], condition: "PL-CW" });
  const nested = await call(client, "plumbing_rollup", { pipes: [{ condition: "PL-CW", hanger_every_feet: 8 }], apply: false });
  assert.deepEqual(nested.data.unknown_args, ["pipes[0].hanger_every_feet"]);
  const mixed = await call(client, "plumbing_rollup", { pipes: [{ condition: "PL-CW", hanger_every_m: 3 }], apply: false });
  assert.equal(mixed.isError, true);
  assert.match(mixed.data.error, /^pipes\[0\]\.hanger_every_m is metric; pass units: "metric" with it, or use pipes\[0\]\.hanger_every_ft\.$/);
});

test("suite tools in imperial reply exactly as before #620, apart from units", async () => {
  // one call per tool; each expected reply is what main (56db9dd) returned for the same calls, shape ids left out
  const client = await pair({ suites: "all" });
  await ready(client);
  const same = async (tool: string, args: Record<string, unknown>, expected: Record<string, unknown>) => {
    const r = await call(client, tool, args);
    assert.equal(r.data.units, "imperial", tool);
    assert.deepEqual(JSON.parse(JSON.stringify(r.data, (k, x) => (k === "id" || k === "units" ? undefined : x))), expected, tool);
  };
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 100, 500, 350), condition: "RF-FIELD" });
  for (const y of [100, 350]) await call(client, "measure_line", { sheet: KEY, pts: [[100, y], [500, y]], condition: "RF-EAVE" });
  for (const x of [100, 500]) await call(client, "measure_line", { sheet: KEY, pts: [[x, 100], [x, 350]], condition: "RF-RAKE" });
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 225], [500, 225]], condition: "RF-RIDGE" });
  await same("roof_takeoff", { pitch: "6/12", ice_water: { eave_ft: 3 }, waste_pct: 12 }, {
    "pitch": "6/12",
    "slope_factor": 1.118,
    "hip_valley_factor": 1.0607,
    "plan_sf": 1000,
    "sloped_sf": 1118.03,
    "squares": 11.18,
    "waste_pct": 12,
    "waste_source": "stated",
    "squares_with_waste": 12.52,
    "edges_plan_lf": {"eave": 80, "rake": 50, "ridge": 40, "hip": 0, "valley": 0},
    "edges_true_lf": {"eave": 80, "rake": 55.9, "ridge": 40, "hip": 0, "valley": 0},
    "drip_edge_lf": 135.9,
    "starter_lf": 80,
    "ridge_cap_lf": 40,
    "underlayment_sf": 1118.03,
    "ice_water_sf": 240,
    "not_figured": [],
    "committed": 7,
    "undo_steps": 3,
    "multipliers_set": {"RF-FIELD": 1.118034, "RF-RAKE": 1.118034},
    "next": "view_sheet overlay:true on the roof to check the derived runs; count penetrations under RF-PEN-<type>; export_report carries the true totals.",
  });
  await same("soffit_takeoff", { overhang_in: 12, rake_overhang_in: 12, pitch: "6/12", vent: { attic_sf: 1000, ratio: 300, nfa_in2_per_lf: 4 } }, {
    "overhang_in": 12,
    "eave_soffit_sf": 80,
    "rake_soffit_sf": 55.9,
    "corner_sf": 0,
    "soffit_sf": 135.9,
    "waste_pct": 10,
    "waste_source": "suite allowance — override with your standard",
    "soffit_order_sf": 149.49,
    "fascia_lf": 135.9,
    "wall_receiver_lf": 135.9,
    "vent": {"attic_sf": 1000, "ratio": "1/300", "required_nfa_in2": 480, "intake_share": 0.5, "intake_nfa_in2": 240, "vented_soffit_lf": 60},
    "not_figured": [],
    "committed": 8,
    "undo_steps": 2,
    "next": "view_sheet overlay:true to check the runs.",
  });

  await call(client, "measure_polygon", { sheet: KEY, verts: rect(100, 600, 400, 700), condition: "SD-WALL" });
  await call(client, "measure_polygon", { sheet: KEY, verts: rect(300, 630, 330, 670), condition: "SD-WALL", role: "deduct" });
  const door = await call(client, "measure_polygon", { sheet: KEY, verts: rect(200, 630, 230, 700), condition: "SD-OPEN" });
  await call(client, "measure_line", { sheet: KEY, pts: [[100, 600], [100, 700]], condition: "SD-OSC" });
  await same("siding_takeoff", { door_openings: [door.data.shape_id], exposure_in: 8, piece_length_ft: 12 }, {
    "walls": [{"gross_sf": 300, "starter_lf": 27}],
    "openings": [{"sf": 12, "sides": 4, "trim_lf": 14}, {"sf": 21, "sides": 3, "trim_lf": 17}],
    "gross_sf": 300,
    "openings_sf": 33,
    "net_sf": 267,
    "squares": 2.67,
    "waste_pct": 10,
    "waste_source": "suite allowance — override with your standard",
    "order_sf": 293.7,
    "order_squares": 2.94,
    "starter_lf": 27,
    "opening_trim_lf": 31,
    "outside_corner_lf": 10,
    "inside_corner_lf": 0,
    "pieces": 37,
    "piece": "8\" reveal × 12' piece, waste included",
    "committed": 5,
    "undo_steps": 2,
    "next": "view_sheet overlay:true on each elevation: starter must sit on wall bottoms and trim around every opening. Corners not measured read 0 — measure_line them under the corner tags.",
  });

  const f = await call(client, "measure_polygon", { sheet: KEY, verts: rect(600, 100, 720, 180), condition: "GL-SF1" });
  await same("glazing_takeoff", { condition: "GL-SF1", grid: [{ shape_id: f.data.shape_id, bays: 3, rows: 2 }], sightline_in: 2.5 }, {
    "openings": [{"width_ft": 12, "height_ft": 8, "rectangular": true, "frame_sf": 96, "lites": 6, "lite_dlo": "44.67\" × 44.25\"", "glass_sf": 82.35, "vertical_mullion_lf": 16, "horizontal_mullion_lf": 12, "perimeter_lf": 40, "sealant_lf": 80}],
    "totals": {"frames": 1, "frame_sf": 96, "lites": 6, "glass_sf": 82.35, "vertical_mullion_lf": 16, "horizontal_mullion_lf": 12, "sealant_lf": 80},
    "non_rectangular": [],
    "committed": 3,
    "undo_steps": 1,
    "next": "view_sheet overlay:true on each elevation: mullions are drawn at equal spacing; edit_shape any that differ. Non-rectangular frames use their bounding box for the grid.",
  });

  await call(client, "measure_line", { sheet: KEY, pts: [[100, 900], [1100, 900]], condition: "E-BR" });
  await call(client, "place_count", { sheet: KEY, points: [[150, 950], [250, 950], [350, 950]], condition: "E-DUP" });
  await call(client, "place_count", { sheet: KEY, points: [[150, 850], [250, 850]], condition: "E-LT1" });
  await same("electrical_rollup", { runs: [{ condition: "E-BR", conductors: 3 }], devices: ["E-DUP"], fixtures: [{ condition: "E-LT1" }], apply: false }, {
    "runs": [{"tag": "E-BR", "conduit_lf": 100, "conductors": 3, "sets": 1, "slack_pct": 10, "wire_lf": 330, "couplings": 10, "straps": 10}],
    "devices": [{"tag": "E-DUP", "ea": 3, "boxes": 3, "plates": 3}],
    "fixtures": [{"tag": "E-LT1", "ea": 2, "whip_ft": 6, "whip_lf": 12}],
    "totals": {"conduit_lf": 100, "wire_lf": 330, "couplings": 10, "straps": 10, "boxes": 3, "whip_lf": 12},
    "committed": 0,
    "undo_steps": 0,
    "next": "Report only — apply:true writes the material rows.",
  });

  await call(client, "measure_line", { sheet: KEY, pts: [[100, 1000], [1050, 1000]], condition: "P-CW-3/4" });
  await call(client, "place_count", { sheet: KEY, points: [[150, 1050], [250, 1050], [350, 1050]], condition: "P-LAV1" });
  await same("plumbing_rollup", { fixtures: [{ condition: "P-LAV1", schedule_qty: 4 }], pipes: [{ condition: "P-CW-3/4", hanger_every_ft: 8, insulate: true, fittings_per_100_lf: 12 }] }, {
    "pipes": [{"tag": "P-CW-3/4", "lf": 95, "hangers": 12, "hanger_every_ft": 8, "fittings_allowance": 12, "fittings_per_100_lf": 12, "insulation_lf": 95}],
    "fixtures": [{"tag": "P-LAV1", "counted": 3, "schedule_qty": 4, "status": "mismatch", "carried": 3}],
    "needs_you": ["P-LAV1: plans count 3, schedule QTY 4 — carried the plan count; confirm"],
    "totals": {"pipe_lf": 95, "hangers": 12, "fixtures": 3},
    "not_figured": [],
    "committed": 0,
    "undo_steps": 1,
    "next": "Settle needs_you with the estimator (or create_rfi) before the counts go out.",
  });
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

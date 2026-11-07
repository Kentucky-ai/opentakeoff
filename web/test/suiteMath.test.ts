// Trade-suite math (lib/suiteMath.ts) and the suite registry (lib/tradeSuites.ts).
// Every expected number below is worked by hand in the comment beside it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePitch, slopeFactor, hipValleyFactor, roofQuantities, bottomEdges, starterRuns, sidingQuantities,
  soffitQuantities, glazingOpening, electricalRollup, plumbingRollup, ringAreaSf, ringPerimeter, type Pt,
} from "../src/lib/suiteMath.ts";
import { TRADE_SUITES, SUITE_TOOL_NAMES, suitesForDivision, suiteOfTool, suiteCatalogLines } from "../src/lib/tradeSuites.ts";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("parsePitch reads what roof plans print and refuses the rest", () => {
  assert.equal(parsePitch("6/12"), 6);
  assert.equal(parsePitch("4:12"), 4);
  assert.equal(parsePitch("8 in 12"), 8);
  assert.equal(parsePitch(7), 7);
  assert.equal(parsePitch("1/4 per ft"), 0.25);      // 1/4" rise per 12" run
  assert.equal(parsePitch('1/4" per foot'), 0.25);
  assert.equal(parsePitch("steep"), null);
  assert.equal(parsePitch(-2), null);
});

test("slope and hip factors", () => {
  near(slopeFactor(6), Math.sqrt(1.25), 1e-9);        // 1.1180
  near(hipValleyFactor(6), Math.sqrt(1.125), 1e-9);    // 1.0607
  near(slopeFactor(0), 1, 1e-12);
  near(slopeFactor(12), Math.SQRT2, 1e-9);             // 45°
});

test("roofQuantities: 1,000 SF plan at 6/12 with hips and valleys", () => {
  const q = roofQuantities({ pitch: 6, plan_sf: 1000, edges: { eave: 100, rake: 40, ridge: 30, hip: 20, valley: 10 }, ice_water: { eave_ft: 3 } });
  near(q.sloped_sf, 1118.03);           // 1000 × 1.11803
  near(q.squares, 11.18);
  assert.equal(q.waste_pct, 15);        // hips/valleys present → 15 % allowance
  assert.match(q.waste_source, /allowance/);
  near(q.squares_with_waste, 12.86);    // 1118.03 × 1.15 / 100
  near(q.edges_true_lf.rake, 44.72);    // 40 × 1.11803
  near(q.edges_true_lf.hip, 21.21);     // 20 × 1.06066
  near(q.edges_true_lf.valley, 10.61);
  near(q.drip_edge_lf, 144.72);         // eave 100 + rake 44.72
  near(q.starter_lf, 100);
  near(q.ridge_cap_lf, 51.21);          // ridge 30 + hip 21.21
  near(q.ice_water_sf!, 300);           // eave 100 × 3 ft
  assert.ok(q.not_figured.some((s) => /valleys/.test(s)), "valley band not given → named as not figured");
});

test("roofQuantities: gable only takes the 10 % allowance; a stated waste wins", () => {
  assert.equal(roofQuantities({ pitch: 4, plan_sf: 500, edges: { eave: 50, rake: 20, ridge: 25, hip: 0, valley: 0 } }).waste_pct, 10);
  const q = roofQuantities({ pitch: 4, plan_sf: 500, edges: { eave: 50, rake: 20, ridge: 25, hip: 0, valley: 0 }, waste_pct: 7 });
  assert.equal(q.waste_pct, 7);
  assert.equal(q.waste_source, "stated");
});

test("bottomEdges finds the lowest horizontal edge of an elevation ring (y down)", () => {
  // a gable end: 20 wide, eave line at y=10, peak at y=0, base at y=18
  const gable: Pt[] = [[0, 18], [0, 10], [10, 0], [20, 10], [20, 18]];
  const b = bottomEdges(gable);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], [[20, 18], [0, 18]]);
});

test("starterRuns cuts out a door sitting on the wall bottom", () => {
  const runs = starterRuns(rect(0, 0, 30, 10), [rect(10, 3, 13, 10)], 0.5);
  const lens = runs.map(([a, b]) => Math.abs(b[0] - a[0])).sort((x, y) => x - y);
  assert.deepEqual(lens, [10, 17]);     // 0→10 and 13→30
});

test("sidingQuantities: one wall, a window, a door", () => {
  const q = sidingQuantities({
    walls: [{ id: "w", ring: rect(0, 0, 30, 10), sheet: "A" }],
    openings: [
      { id: "win", ring: rect(20, 3, 23, 7), sides: 4, sheet: "A" },     // 3 × 4 = 12 SF, trim 14
      { id: "door", ring: rect(10, 3, 13, 10), sides: 3, sheet: "A" },   // 3 × 7 = 21 SF, trim 20 − 3 = 17
    ],
    outside_corner_lf: 20, exposure_in: 8, piece_length_ft: 12,
  });
  near(q.gross_sf, 300);
  near(q.openings_sf, 33);
  near(q.net_sf, 267);
  near(q.opening_trim_lf, 31);
  near(q.starter_lf, 27);               // 30 minus the 3 ft door
  near(q.order_sf, 293.7);              // 267 × 1.10
  assert.equal(q.pieces, 37);           // 293.7 ÷ (8/12 × 12 = 8 SF) = 36.7 → 37
  near(q.outside_corner_lf, 20);
});

test("soffitQuantities: eave + rake soffit, corners, fascia, intake vent", () => {
  const q = soffitQuantities({
    eave_lf: 100, rake_plan_lf: 40, overhang_in: 12, rake_overhang_in: 6, pitch: 6, outside_corners: 4,
    vent: { attic_sf: 1500, ratio: 150, nfa_in2_per_lf: 9 },
  });
  near(q.eave_soffit_sf, 100);          // 100 × 1 ft
  near(q.rake_soffit_sf, 22.36);        // 44.72 true × 0.5 ft
  near(q.corner_sf, 4);                 // 4 × 1 × 1
  near(q.soffit_sf, 126.36);
  near(q.fascia_lf, 144.72);
  near(Number(q.vent!.required_nfa_in2), 1440);   // 1500 / 150 = 10 SF = 1440 in²
  near(Number(q.vent!.intake_nfa_in2), 720);
  near(Number(q.vent!.vented_soffit_lf), 80);     // 720 / 9
  assert.deepEqual(q.not_figured, []);
});

test("glazingOpening: 12 × 8 storefront, 3 bays × 2 rows, 2\" sightlines", () => {
  const o = glazingOpening({ id: "f", ring: rect(0, 0, 12, 8), bays: 3, rows: 2, sightline_in: 2, sealant_sides: 2 });
  assert.equal(o.rectangular, true);
  assert.equal(o.lites, 6);
  near(o.glass_sf, 85);                 // 6 × ((12 − 4·2/12)/3) × ((8 − 3·2/12)/2) = 6 × 3.7778 × 3.75
  near(o.vertical_mullion_lf, 16);      // 2 × 8
  near(o.horizontal_mullion_lf, 12);    // 1 × 12
  near(o.sealant_lf, 80);               // perimeter 40 × 2
  assert.equal(o.mullions.length, 3);
  assert.deepEqual(o.mullions[0], [[4, 0], [4, 8]]);
});

test("electricalRollup: wire, couplings, straps, boxes, whips", () => {
  const q = electricalRollup({
    runs: [{ tag: "E-BR", conduit_lf: 100, conductors: 3, sets: 1, slack_pct: 10 }],
    devices: [{ tag: "E-DUP", ea: 12 }], fixtures: [{ tag: "E-FIX-A", ea: 8, whip_ft: 6 }],
    coupling_every_ft: 10, strap_every_ft: 8,
  });
  near(q.runs[0].wire_lf, 330);         // 100 × 3 × 1.10
  assert.equal(q.runs[0].couplings, 10);
  assert.equal(q.runs[0].straps, 13);   // 100 / 8 = 12.5 → 13
  assert.equal(q.totals.boxes, 12);
  near(q.totals.whip_lf, 48);
});

test("plumbingRollup: schedule check carries the plan count and names every difference", () => {
  const q = plumbingRollup({
    fixtures: [{ tag: "P-WC1", counted: 4, schedule_qty: 4 }, { tag: "P-LAV1", counted: 3, schedule_qty: 4 }, { tag: "P-MOP", counted: 0, schedule_qty: 2 }, { tag: "P-DF", counted: 1 }],
    pipes: [{ tag: "P-CW-3/4", lf: 95, hanger_every_ft: 8, fittings_per_100_lf: 5, insulate: true }, { tag: "P-SAN-4", lf: 40 }],
  });
  assert.deepEqual(q.fixtures.map((x) => [x.tag, x.status, x.carried]), [["P-WC1", "match", 4], ["P-LAV1", "mismatch", 3], ["P-MOP", "not_tagged", 2], ["P-DF", "no_schedule_qty", 1]]);
  assert.equal(q.needs_you.length, 2);
  assert.equal(q.totals.fixtures, 10);
  assert.equal(q.pipes[0].hangers, 12);              // 95 / 8 = 11.9 → 12
  assert.equal(q.pipes[0].fittings_allowance, 5);    // 95 × 5 / 100 = 4.75 → 5
  near(q.pipes[0].insulation_lf!, 95);
  assert.ok(q.not_figured.some((s) => s.startsWith("P-SAN-4")), "no hanger spacing → not figured, never assumed");
});

test("ring helpers ignore a repeated closing point", () => {
  const r = rect(0, 0, 4, 3);
  near(ringAreaSf([...r, r[0]]), 12, 1e-9);
  near(ringPerimeter([...r, r[0]]), 14, 1e-9);
});

test("registry: ids unique, every suite has a method, divisions route, tools are owned once", () => {
  const ids = TRADE_SUITES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of TRADE_SUITES) {
    assert.ok(s.method.length > 40, `${s.id} carries a method`);
    assert.ok(s.summary.length < 140, `${s.id} summary stays one line`);
    for (const t of s.tools) assert.equal(suiteOfTool(t)?.id, s.id);
  }
  assert.deepEqual(suitesForDivision("07").map((s) => s.id), ["roofing", "siding", "soffit_fascia"]);
  assert.deepEqual(suitesForDivision("Div 26 05 00").map((s) => s.id), ["electrical"]);
  assert.deepEqual(suitesForDivision("8").map((s) => s.id), ["glazing", "doors"]);
  assert.deepEqual([...SUITE_TOOL_NAMES], ["electrical_rollup", "glazing_takeoff", "plumbing_rollup", "roof_takeoff", "siding_takeoff", "soffit_takeoff"]);
  assert.equal(suiteCatalogLines().length, TRADE_SUITES.length);
});

test("registry: no prices or product names in any suite text", () => {
  const text = JSON.stringify(TRADE_SUITES).toLowerCase();
  assert.doesNotMatch(text, /\$\s*\d/);
  assert.doesNotMatch(text, /[®™]|\bsku\b|\bmodel no/);
});

test("trade view: explicit trade wins, then tag prefix, then Finishes; the view hides other trades only", async () => {
  const { conditionTrade, tradeHiddenIds, tradeCounts, sanitizeViewTrade, ALL_TRADES } = await import("../src/lib/tradeSuites.ts");
  assert.equal(conditionTrade({ finish_tag: "RF-FIELD" }), "roofing");
  assert.equal(conditionTrade({ finish_tag: "sd-wall" }), "siding");          // case-insensitive
  assert.equal(conditionTrade({ finish_tag: "SF-SOFFIT" }), "soffit_fascia");
  assert.equal(conditionTrade({ finish_tag: "P-WC1" }), "plumbing");
  assert.equal(conditionTrade({ finish_tag: "FA-HORN" }), "electrical");
  assert.equal(conditionTrade({ finish_tag: "PT-1" }), "finishes");           // paint is not plumbing
  assert.equal(conditionTrade({ finish_tag: "LVT-1" }), "finishes");          // pre-suite takeoffs read as finishes
  assert.equal(conditionTrade({ finish_tag: "LVT-1", trade: "glazing" }), "glazing");
  assert.equal(conditionTrade({ finish_tag: "RF-1", trade: "nonsense" }), "roofing");
  const cs = [{ id: "a", finish_tag: "RF-FIELD" }, { id: "b", finish_tag: "LVT-1" }, { id: "c", finish_tag: "X", trade: "roofing" }];
  assert.deepEqual([...tradeHiddenIds(cs, "roofing")], ["b"]);
  assert.equal(tradeHiddenIds(cs, ALL_TRADES).size, 0);
  assert.equal(tradeHiddenIds(cs, "bogus").size, 0);
  assert.deepEqual(tradeCounts(cs), { roofing: 2, finishes: 1 });
  assert.equal(sanitizeViewTrade("siding"), "siding");
  assert.equal(sanitizeViewTrade("drop table"), "all");
  assert.equal(sanitizeViewTrade(null), "all");
});

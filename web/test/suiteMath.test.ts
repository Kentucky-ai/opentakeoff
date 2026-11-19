// Trade-suite math (lib/suiteMath.ts) and the suite registry (lib/tradeSuites.ts).
// Every expected number below is worked by hand in the comment beside it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePitch, slopeFactor, hipValleyFactor, roofQuantities, bottomEdges, starterRuns, sidingQuantities,
  soffitQuantities, glazingOpening, electricalRollup, plumbingRollup, ceilingQuantities, parseCeilingModule, slabQuantities, footingQuantities, concreteWallQuantities, padQuantities, rebarQuantities, barsEachWayLf, parseBarSize, ringAreaSf, ringPerimeter, type Pt,
} from "../src/lib/suiteMath.ts";
import { TRADE_SUITES, SUITE_TOOL_NAMES, suitesForDivision, suiteOfTool, suiteCatalogLines } from "../src/lib/tradeSuites.ts";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("parsePitch reads what roof plans print and refuses the rest", () => {
  assert.equal(parsePitch("6/12"), 6);
  assert.equal(parsePitch("4:12"), 4);
  assert.equal(parsePitch("8 in 12"), 8);
  assert.equal(parsePitch("6in12"), 6);              // no spaces, as main reads it
  assert.equal(parsePitch("0.25in12"), 0.25);
  assert.equal(parsePitch(7), 7);
  assert.equal(parsePitch("2"), 2);                  // ambiguous integer keeps rise per 12
  assert.equal(parsePitch(0), 0);
  assert.equal(parsePitch("0"), 0);
  assert.equal(parsePitch("1/4 per ft"), 0.25);      // 1/4" rise per 12" run
  assert.equal(parsePitch('1/4" per foot'), 0.25);
  assert.equal(parsePitch("2%"), 0.24);              // 2 rise per 100 run = 2/100 * 12 = 0.24
  assert.equal(parsePitch("22.5 deg"), 4.971);       // 12 * tan(22.5°) = 4.97056... ≈ 4.971
  assert.equal(parsePitch("22.5°"), 4.971);
  assert.equal(parsePitch("1:48"), 0.25);            // 1 rise per 48 run = 1/48 * 12 = 0.25
  assert.equal(parsePitch("1/4:12"), 0.25);          // 1/4" in 12
  assert.equal(parsePitch("flat"), null);            // flat roof stays refused: pass 0 if drawing says 0
  assert.equal(parsePitch("1/4"), null);             // ambiguous fraction stays refused
  assert.equal(parsePitch("steep"), null);
  assert.equal(parsePitch(-2), null);
  assert.equal(parsePitch(50), null);
  assert.equal(parsePitch("90 deg"), null);
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

test("starterRuns: bottom edge on another wall edge gets no starter (#619)", () => {
  const wall = rect(10, 0, 40, 10);                       // top at y=0, bottom at y=10
  const gable: Pt[] = [[10, 0], [40, 0], [25, -7.5]];     // bottom at y=0
  assert.deepEqual(starterRuns(gable, [], 0.5, [wall]), []);
  const wallRuns = starterRuns(wall, [], 0.5, [gable]);
  assert.equal(wallRuns.length, 1);
  near(Math.abs(wallRuns[0][1][0] - wallRuns[0][0][0]), 30);
});

test("starterRuns: stubs shorter than tol are dropped, stubs >= tol are kept (#619)", () => {
  const wall = rect(10, 0, 40, 10);                       // top at y=0, bottom at y=10
  // Gable with small 0.3 ft and 0.4 ft overhangs (< tol 0.5): dropped
  const gableSlivers: Pt[] = [[9.7, 0.1], [40.4, -0.1], [25, -7.5]];
  assert.deepEqual(starterRuns(gableSlivers, [], 0.5, [wall]), []);

  // Gable with 2 ft overhangs on each side (>= tol 0.5): kept as stubs
  const gableOverhang: Pt[] = [[8, 0], [42, 0], [25, -7.5]];
  const stubs = starterRuns(gableOverhang, [], 0.5, [wall]);
  assert.equal(stubs.length, 2);
  near(Math.abs(stubs[0][1][0] - stubs[0][0][0]), 2);
  near(Math.abs(stubs[1][1][0] - stubs[1][0][0]), 2);
});

test("sidingQuantities: overlapping walls with bottoms on one line do not cancel (#619)", () => {
  // 30 ft wall with 10 ft wall traced over its lower middle
  const q = sidingQuantities({
    walls: [
      { id: "w30", ring: rect(0, 0, 30, 10), sheet: "A" },
      { id: "w10", ring: rect(10, 5, 20, 10), sheet: "A" },
    ],
    openings: [],
  });
  assert.equal(q.walls.find((w) => w.id === "w30")?.starter_lf, 30);
  assert.equal(q.walls.find((w) => w.id === "w10")?.starter_lf, 10);
  near(q.starter_lf, 40);
});

test("sidingQuantities: gable as its own shape vs 5-point polygon (#619)", () => {
  // 1. Traced as two shapes: 30 × 10 wall and 30 × 7.5 gable above it
  const two = sidingQuantities({
    walls: [
      { id: "wall", ring: rect(10, 10, 40, 20), sheet: "A" },
      { id: "gable", ring: [[10, 10], [40, 10], [25, 2.5]], sheet: "A" },
    ],
    openings: [],
    exposure_in: 4, piece_length_ft: 12,
  });
  near(two.gross_sf, 412.5);
  near(two.net_sf, 412.5);
  near(two.starter_lf, 30);                               // wall bottom only, not the gable
  assert.equal(two.walls.find((w) => w.id === "wall")?.starter_lf, 30);
  assert.equal(two.walls.find((w) => w.id === "gable")?.starter_lf, 0);

  // 2. Traced as one 5-point polygon (wall plus gable): exact same numbers
  const one = sidingQuantities({
    walls: [
      { id: "wall_plus_gable", ring: [[10, 20], [40, 20], [40, 10], [25, 2.5], [10, 10]], sheet: "A" },
    ],
    openings: [],
    exposure_in: 4, piece_length_ft: 12,
  });
  near(one.gross_sf, 412.5);
  near(one.net_sf, 412.5);
  near(one.starter_lf, 30);

  // 3. Wall split at a floor line: 2nd floor sits on 1st floor top edge
  const split = sidingQuantities({
    walls: [
      { id: "fl1", ring: rect(0, 10, 30, 20), sheet: "A" },
      { id: "fl2", ring: rect(0, 0, 30, 10), sheet: "A" },
    ],
    openings: [],
  });
  near(split.starter_lf, 30);                             // 1st floor bottom only
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

test("ceilingQuantities: the #614 finish line — a 20 × 30 ft room in 2 × 2 tile", () => {
  const q = ceilingQuantities({ area_sf: 600, perimeter_lf: 100, module_w_ft: 2, module_l_ft: 2, hanger_spacing_ft: 4 });
  assert.equal(q.tiles, 150);                         // 600 SF / 4 SF per tile
  assert.equal(q.wall_angle_lf, 100);                 // 2 × (20 + 30)
  near(q.main_spacing_ft, 4);                          // square module: mains at 2 × 2 ft
  near(q.main_runner_lf, 150);                         // 600 / 4 ft
  assert.equal(q.main_runners, 13);                    // 150 LF / 12 ft pieces = 12.5, rounded up
  assert.equal(q.cross_tees_long, 75);                 // 600 / (4 × 2): one 4 ft tee per 8 SF
  assert.equal(q.cross_tees_short, 75);                // 600 / (4 × 2): one 2 ft tee per 8 SF
  // grid LF per SF = 150/600 + 75·4/600 + 75·2/600 = 0.25 + 0.5 + 0.25 = 1, a line every 2 ft both ways
  near((q.main_runner_lf + q.cross_tees_long * q.cross_tee_long_ft + q.cross_tees_short * q.cross_tee_short_ft) / 600, 1);
  assert.equal(q.hangers, 38);                         // 600 / (4 ft mains × 4 ft along) = 37.5, rounded up
  assert.equal(q.waste_pct, 10);
  assert.match(q.waste_source, /allowance/);
  assert.equal(q.tiles_order, 165);                    // 150 × 1.10
  assert.equal(q.not_figured.length, 2, "density counts say what a laid-out grid would add");
  assert.ok(q.not_figured.some((s) => s.startsWith("border tiles")));
  assert.ok(q.not_figured.some((s) => /seismic/.test(s)));
});

test("ceilingQuantities: 2 × 4 module, an L-shaped room, rounding up, missing hanger spacing", () => {
  const q = ceilingQuantities({ area_sf: 600, perimeter_lf: 100, module_w_ft: 2, module_l_ft: 4, waste_pct: 5, main_piece_ft: 10 });
  assert.equal(q.tiles, 75);                           // 600 / 8
  near(q.main_spacing_ft, 4);                          // mains at the long side
  assert.equal(q.main_runners, 15);                    // 150 LF / 10 ft pieces
  assert.equal(q.cross_tees_long, 75);                 // 600 / (4 × 2)
  assert.equal(q.cross_tees_short, 0);                 // no short tees in a 2 × 4 grid
  assert.equal(q.tiles_order, 79);                     // 75 × 1.05 = 78.75, rounded up
  assert.equal(q.waste_source, "stated");
  assert.equal(q.hangers, undefined);
  assert.ok(q.not_figured.some((s) => s.startsWith("hanger wires")), "no hanger spacing → not figured, never assumed");

  // 20 × 30 with a 10 × 10 corner taken out: 500 SF, the perimeter unchanged at 100 LF
  const L = ceilingQuantities({ area_sf: 500, perimeter_lf: 100, module_w_ft: 2, module_l_ft: 2 });
  assert.equal(L.tiles, 125);
  assert.equal(L.wall_angle_lf, 100);
  assert.equal(ceilingQuantities({ area_sf: 601, perimeter_lf: 0, module_w_ft: 2, module_l_ft: 2 }).tiles, 151);   // 150.25 → 151
  assert.throws(() => ceilingQuantities({ area_sf: 600, perimeter_lf: 100, module_w_ft: 2, module_l_ft: 3 }), /square or twice as long/);
});

test("parseCeilingModule reads the module as the plan prints it; metric is in mm", () => {
  assert.deepEqual(parseCeilingModule("2x2"), { w_ft: 2, l_ft: 2 });
  assert.deepEqual(parseCeilingModule("2' x 4'"), { w_ft: 2, l_ft: 4 });
  assert.deepEqual(parseCeilingModule("4×2"), { w_ft: 2, l_ft: 4 });     // short side first
  const m = parseCeilingModule("600x1200", true)!;
  near(m.w_ft, 1.9685, 1e-4);                                            // 600 / 304.8
  near(m.l_ft, 3.937, 1e-3);
  assert.equal(parseCeilingModule("two by two"), null);
  // 600 × 600 mm over 600 SF (55.74 m²): 55.74 / 0.36 = 154.8 → 155 tiles; mains at 1200 mm
  const q = ceilingQuantities({ area_sf: 600, perimeter_lf: 100, module_w_ft: parseCeilingModule("600x600", true)!.w_ft, module_l_ft: parseCeilingModule("600x600", true)!.l_ft });
  assert.equal(q.tiles, 155);
  near(q.main_spacing_ft * 0.3048, 1.2, 1e-4);                            // reported to 4 places
});

test("ring helpers ignore a repeated closing point", () => {
  const r = rect(0, 0, 4, 3);
  near(ringAreaSf([...r, r[0]]), 12, 1e-9);
  near(ringPerimeter([...r, r[0]]), 14, 1e-9);
});

test("parseBarSize reads the sizes the structural notes print", () => {
  assert.equal(parseBarSize("#4"), "4");
  assert.equal(parseBarSize(5), "5");
  assert.equal(parseBarSize("No. 6"), "6");
  assert.equal(parseBarSize(" #11 "), "11");
  assert.equal(parseBarSize("#2"), null);           // below the deformed bar range
  assert.equal(parseBarSize("#12"), null);
  assert.equal(parseBarSize("10M"), null);          // metric bar designations are not a US size
  assert.equal(parseBarSize("four"), null);
});

test("slabQuantities: a 40 × 25 ft slab at 5 in (the #611 finish line)", () => {
  const q = slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5 });
  near(q.concrete_cy, 15.43);            // 1000 × 5/12 = 416.67 CF / 27
  assert.equal(q.waste_pct, 5);
  assert.match(q.waste_source, /allowance/);
  near(q.order_cy, 16.2);                // 15.432 × 1.05
  near(q.edge_form_lf, 130);             // 2 × (40 + 25)
  near(q.edge_form_sf, 54.17);           // 130 × 5/12
  assert.ok(q.not_figured.some((s) => /reinforcing/.test(s)), "no bars given → named");
  assert.ok(q.not_figured.some((s) => /base course/.test(s)), "no base depth → named");
  const stated = slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5, waste_pct: 0 });
  assert.equal(stated.waste_source, "stated");
  near(stated.order_cy, 15.43);
  const open = slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5, edge_form: false });
  assert.equal(open.edge_form_lf, 0);
  assert.throws(() => slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 0 }), /thickness_in/);
});

test("rebar: #4 at 12 in each way on that slab, 24 in laps on 20 ft bars", () => {
  assert.equal(barsEachWayLf(1000, 12), 2000);       // 1000 LF each way
  assert.equal(barsEachWayLf(1000, 12, 2), 4000);    // two mats
  near(barsEachWayLf(160, 18), 213.33);              // 160 / 1.5 each way × 2
  const q = slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5, bars: { size: "#4", spacing_in: 12, lap_in: 24 } });
  const r = q.rebar!;
  assert.equal(r.size, "#4");
  near(r.net_lf, 2000);
  near(r.lf, 2222.22);                   // 2000 × 20 / (20 − 2): each piece but the first gives up its lap
  near(r.lap_lf, 222.22);
  assert.equal(r.pieces, 112);           // 2222.22 / 20 = 111.1
  near(r.weight_lb, 1484.44);            // 2222.22 × 0.668 lb/ft
  assert.match(r.stock_source, /allowance/);
  assert.ok(!q.not_figured.some((s) => /bar laps/.test(s)));
  const noLap = slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5, bars: { size: "4", spacing_in: 12 } });
  near(noLap.rebar!.lf, 2000);
  near(noLap.rebar!.weight_lb, 1336);    // 2000 × 0.668
  assert.ok(noLap.not_figured.some((s) => /bar laps/.test(s)), "no lap → bar LF is the net run, and says so");
  assert.throws(() => rebarQuantities(100, { size: "#4", lap_in: 240 }), /not shorter/);
  assert.throws(() => rebarQuantities(100, { size: "#14" }), /not a US bar size/);
  near(rebarQuantities(100, { size: "#8", stock_ft: 40 }).weight_lb, 267);   // 100 × 2.67
});

test("slabQuantities: welded wire by area with its side lap, base course, vapor barrier", () => {
  const q = slabQuantities({
    area_sf: 1000, perimeter_lf: 130, thickness_in: 5,
    mesh: { roll_width_ft: 5, lap_in: 6 }, base_depth_in: 4, vapor_barrier: true,
  });
  near(q.mesh_sf!, 1111.11);             // 1000 × 5 / (5 − 0.5)
  near(q.base_cy!, 12.35);               // 1000 × 4/12 = 333.33 CF / 27
  assert.equal(q.vapor_barrier_sf, 1000);
  assert.throws(() => slabQuantities({ area_sf: 1000, perimeter_lf: 130, thickness_in: 5, mesh: { roll_width_ft: 0.4, lap_in: 6 } }), /wider than its lap/);
});

test("footingQuantities: 130 LF of 24 × 12 in footing (the #611 finish line)", () => {
  const q = footingQuantities({ length_lf: 130, width_in: 24, depth_in: 12 });
  near(q.concrete_cy, 9.63);             // 130 × 2 ft × 1 ft = 260 CF / 27
  near(q.order_cy, 10.11);               // 9.630 × 1.05
  near(q.form_sf, 260);                  // two sides × 130 LF × 1 ft
  assert.ok(q.not_figured.some((s) => /footing reinforcing/.test(s)));
  const b = footingQuantities({ length_lf: 130, width_in: 24, depth_in: 12, bars: { size: "#5", count: 3, lap_in: 30, stock_ft: 20 } });
  near(b.rebar!.net_lf, 390);            // 3 bars × 130 LF
  near(b.rebar!.lf, 445.71);             // 390 × 20 / (20 − 2.5)
  near(b.rebar!.weight_lb, 464.88);      // 445.714 × 1.043
});

test("concreteWallQuantities and padQuantities", () => {
  const w = concreteWallQuantities({ area_sf: 160, thickness_in: 8, bars: { size: "#5", spacing_in: 18 } });   // 20 ft × 8 ft
  near(w.concrete_cy, 3.95);             // 160 × 8/12 = 106.67 CF / 27
  near(w.form_sf, 320);                  // both faces
  near(w.rebar!.lf, 213.33);             // 160 / 1.5 each way × 2
  assert.equal(w.rebar!.pieces, 11);
  near(w.rebar!.weight_lb, 222.51);      // 213.33 × 1.043
  const p = padQuantities({ count: 4, length_ft: 4, width_ft: 4, depth_in: 18 });
  near(p.concrete_cy, 3.56);             // 4 × 4 × 4 × 1.5 = 96 CF / 27
  near(p.form_sf, 96);                   // 4 pads × 16 ft of side × 1.5 ft
  assert.throws(() => padQuantities({ count: 4, length_ft: 0, width_ft: 4, depth_in: 18 }), /positive/);
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
  assert.deepEqual(suitesForDivision("03").map((s) => s.id), ["concrete"]);
  assert.deepEqual(suitesForDivision("Div 26 05 00").map((s) => s.id), ["electrical"]);
  assert.deepEqual(suitesForDivision("8").map((s) => s.id), ["glazing", "doors"]);
  assert.deepEqual([...SUITE_TOOL_NAMES], ["ceiling_takeoff", "concrete_takeoff", "electrical_rollup", "glazing_takeoff", "plumbing_rollup", "roof_takeoff", "siding_takeoff", "soffit_takeoff"]);
  assert.deepEqual(suitesForDivision("09").map((s) => s.id), ["finishes"], "a flooring job does not open ceilings");
  assert.deepEqual(suitesForDivision("09", ["CPT-1", "act-2"]).map((s) => s.id), ["finishes", "acoustical_ceilings"]);
  assert.deepEqual(suitesForDivision("07", ["ACT-1"]).map((s) => s.id), ["roofing", "siding", "soffit_fascia"]);
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
  assert.equal(conditionTrade({ finish_tag: "ACT-2" }), "acoustical_ceilings");
  assert.equal(conditionTrade({ finish_tag: "c-sog-1" }), "concrete");
  for (const t of ["C-FTG-2", "C-PAD-1", "C-WALL-3", "C-JOINT"]) assert.equal(conditionTrade({ finish_tag: t }), "concrete");
  assert.equal(conditionTrade({ finish_tag: "C-1" }), "finishes");            // a bare C- tag is not a concrete tag
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

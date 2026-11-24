// Trade-suite math (lib/suiteMath.ts) and the suite registry (lib/tradeSuites.ts).
// Every expected number below is worked by hand in the comment beside it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePitch, slopeFactor, hipValleyFactor, roofQuantities, bottomEdges, starterRuns, sidingQuantities,
  soffitQuantities, glazingOpening, electricalRollup, plumbingRollup, ceilingQuantities, parseCeilingModule, masonryQuantities, parseMasonryUnit, openingReachesWallTop, jointReinforcementLines, openingWidth, ringAreaSf, ringPerimeter, type Pt,
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

test("parseMasonryUnit reads the face the plans print; metric is in mm", () => {
  assert.deepEqual(parseMasonryUnit("16x8"), { length_in: 16, height_in: 8 });
  assert.deepEqual(parseMasonryUnit('8" × 16"'), { length_in: 16, height_in: 8 });   // either order, with inch marks
  assert.deepEqual(parseMasonryUnit("7.625 x 2.625 in"), { length_in: 7.625, height_in: 2.625 });
  const m = parseMasonryUnit("400x200", true)!;
  near(m.length_in, 15.748, 0.001);                  // 400 mm / 25.4
  near(m.height_in, 7.874, 0.001);
  assert.equal(parseMasonryUnit("16"), null);
  assert.equal(parseMasonryUnit("0x8"), null);
  assert.equal(parseMasonryUnit("big"), null);
});

test("masonryQuantities: the #612 finish line — 30 × 10 ft wall, one 3 × 4 ft opening, 16 × 8 in units", () => {
  const q = masonryQuantities({ gross_sf: 300, openings_sf: 12, unit_length_in: 16, unit_height_in: 8 });
  near(q.net_sf, 288);                    // 300 − 12
  near(q.units_per_sf, 1.125);            // 144 / (16 × 8)
  assert.equal(q.unit_count, 324);        // 288 × 1.125
  assert.equal(q.waste_pct, 5);
  assert.match(q.waste_source, /allowance/);
  assert.equal(q.unit_count_order, 341);  // 324 × 1.05 = 340.2
  assert.ok(q.not_figured.some((s) => /^mortar/.test(s)) && q.not_figured.some((s) => /^grout/.test(s)));
  const bigger = masonryQuantities({ gross_sf: 300, openings_sf: 12, unit_length_in: 12, unit_height_in: 8 });
  assert.equal(bigger.unit_count, 432);   // 288 × 1.5: a different unit changes the count
  assert.equal(masonryQuantities({ gross_sf: 300, openings_sf: 12, unit_length_in: 16, unit_height_in: 8, waste_pct: 0 }).unit_count_order, 324);
  assert.throws(() => masonryQuantities({ gross_sf: 300, openings_sf: 0, unit_length_in: 0, unit_height_in: 8 }), /positive/);
  near(masonryQuantities({ gross_sf: 10, openings_sf: 50, unit_length_in: 16, unit_height_in: 8 }).net_sf, 0);   // openings never exceed the wall
});

test("jointReinforcementLines: bed joints at the spacing, strictly below the top of the wall", () => {
  assert.equal(jointReinforcementLines(10, 16), 7);    // 16, 32, 48, 64, 80, 96, 112 in; 128 is past the 120 in top
  assert.equal(jointReinforcementLines(8, 16), 5);     // 16 … 80 in; the joint at 96 in is the top of the wall
  assert.equal(jointReinforcementLines(8, 8), 11);     // every course of an 8 in unit, less the top
  assert.equal(jointReinforcementLines(1, 16), 0);     // a wall shorter than the spacing takes none
  assert.equal(jointReinforcementLines(0, 16), 0);
  assert.equal(jointReinforcementLines(10, 0), 0);
});

test("openingWidth: measured along the view's ground line, not the sheet's left-to-right", () => {
  const upright: Pt[] = [[0, 0], [3, 0], [3, 7], [0, 7]];               // a 3 × 7 ft door, view upright
  near(openingWidth(upright), 3);
  const onItsSide: Pt[] = [[0, 0], [7, 0], [7, 3], [0, 3]];             // the same door, view drawn on its side
  near(openingWidth(onItsSide), 7);                                     // left-to-right reads the HEIGHT
  near(openingWidth(onItsSide, 90), 3);                                 // stated rotation reads the width
  near(openingWidth(onItsSide, -90), 3);
  const c = Math.SQRT1_2;                                               // the same door on a wing turned 45°
  const angled: Pt[] = upright.map(([x, y]) => [x * c - y * c, x * c + y * c]);
  near(openingWidth(angled, 45), 3);
  assert.ok(Math.abs(openingWidth(angled) - 3) > 3, "unrotated, the 45° door reads 7.07 ft wide");
  assert.equal(openingWidth([]), 0);
});

test("masonryQuantities: mortar, joint reinforcement, vertical bars, grout and lintels", () => {
  const q = masonryQuantities({
    gross_sf: 300, openings_sf: 12, unit_length_in: 16, unit_height_in: 8,
    mortar_cf_per_100_units: 8, runs: [{ length_lf: 30, height_ft: 10 }],
    joint_reinf_spacing_in: 16, vertical_bar_spacing_in: 32, grout: { spacing_in: 32, cell_area_in2: 24 },
    opening_widths_ft: [3], lintel_bearing_in: 8,
  });
  near(q.mortar_cf!, 25.92);               // 324 / 100 × 8
  near(q.joint_reinforcement_lf!, 210);    // 10 ft = 120 in: joints at 16, 32 … 112 in = 7 lines × 30 LF
  near(q.vertical_bar_lf!, 112.5);         // 300 SF / (32/12 ft)
  near(q.grout_cf!, 18.75);                // 300 × (12/32) cells × 24 in² / 144
  assert.deepEqual(q.lintels, { count: 1, lengths_ft: [4.33], total_lf: 4.33, bearing_in: 8 });   // 3 + 2 × 8/12
  near(q.wall_length_lf!, 30);
  assert.ok(!q.not_figured.some((s) => /^(mortar|joint|vertical|grout|lintels)/.test(s)));
  const noBearing = masonryQuantities({ gross_sf: 300, openings_sf: 12, unit_length_in: 16, unit_height_in: 8, opening_widths_ft: [3] });
  assert.equal(noBearing.lintels, undefined);
  assert.ok(noBearing.not_figured.some((s) => /^lintels/.test(s)));
  assert.throws(() => masonryQuantities({ gross_sf: 300, openings_sf: 0, unit_length_in: 16, unit_height_in: 8, grout: { spacing_in: 0, cell_area_in2: 24 } }), /grout needs/);
  assert.throws(() => masonryQuantities({ gross_sf: 300, openings_sf: 0, unit_length_in: 16, unit_height_in: 8, joint_reinf_spacing_in: -1 }), /positive/);
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
  assert.deepEqual(suitesForDivision("04").map((s) => s.id), ["masonry"]);
  assert.deepEqual(suitesForDivision("Div 26 05 00").map((s) => s.id), ["electrical"]);
  assert.deepEqual(suitesForDivision("8").map((s) => s.id), ["glazing", "doors"]);
  assert.deepEqual([...SUITE_TOOL_NAMES], ["ceiling_takeoff", "electrical_rollup", "glazing_takeoff", "masonry_takeoff", "plumbing_rollup", "roof_takeoff", "siding_takeoff", "soffit_takeoff"]);
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
  assert.equal(conditionTrade({ finish_tag: "m-wall-2" }), "masonry");
  for (const t of ["M-OPEN", "M-LINTEL-1", "M-BB", "M-CJ"]) assert.equal(conditionTrade({ finish_tag: t }), "masonry");
  assert.equal(conditionTrade({ finish_tag: "M-1" }), "finishes");            // a bare M- tag is not a masonry tag
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

test("openingReachesWallTop: a door to the top edge takes no lintel, a window below it does", () => {
  const wall: [number, number][] = [[0, 0], [30, 0], [30, 10], [0, 10]];            // y down, top edge at y = 0
  const door: [number, number][] = [[5, 0], [8, 0], [8, 10], [5, 10]];
  const window_: [number, number][] = [[15, 3], [18, 3], [18, 7], [15, 7]];
  assert.equal(openingReachesWallTop(door, [wall]), true);
  assert.equal(openingReachesWallTop(window_, [wall]), false);
  assert.equal(openingReachesWallTop([[5, 0.05], [8, 0.05], [8, 10], [5, 10]], [wall]), true, "a hand-traced edge within 0.1 ft of the top still reaches it");
  assert.equal(openingReachesWallTop([[5, 0.5], [8, 0.5], [8, 10], [5, 10]], [wall]), false);
  assert.equal(openingReachesWallTop(door, []), undefined, "no traced face: no verdict");
  assert.equal(openingReachesWallTop([[40, 0], [43, 0], [43, 10], [40, 10]], [wall]), undefined, "outside every face");
  // a stepped top: the wall is 10 ft on the left and 6 ft on the right; a door to the lower step reaches it
  const stepped: [number, number][] = [[0, 0], [10, 0], [10, 4], [30, 4], [30, 10], [0, 10]];
  assert.equal(openingReachesWallTop([[20, 4], [23, 4], [23, 10], [20, 10]], [stepped]), true);
  assert.equal(openingReachesWallTop([[20, 6], [23, 6], [23, 10], [20, 10]], [stepped]), false);
  // the elevation turned 90°: up on the sheet is +x, so the top edge is the wall's right edge
  const side: [number, number][] = [[0, 0], [10, 0], [10, 30], [0, 30]];
  assert.equal(openingReachesWallTop([[0, 5], [10, 5], [10, 8], [0, 8]], [side], 90), true);
  assert.equal(openingReachesWallTop([[0, 5], [6, 5], [6, 8], [0, 8]], [side], 90), false);
  // lintels: full-height openings are reported, not counted
  const q = masonryQuantities({ gross_sf: 300, openings_sf: 12, unit_length_in: 16, unit_height_in: 8, opening_widths_ft: [3], lintel_bearing_in: 8, full_height_openings: 2 });
  assert.equal(q.lintels?.count, 1);
  assert.deepEqual(q.full_height_openings, { count: 2, note: "full-height: no lintel" });
});

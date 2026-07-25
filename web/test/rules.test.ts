// Correction-rule engine tests (#88) — pure geometry, synthetic ring/segment
// data (no PDF, no DOM). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMask, type Point } from "../src/lib/oneclick.ts";
import {
  ringContains, ringCentroid, defaultMaxAreaSf, detectCandidateRule,
  buildRuleFromSeed, findEnclosedRegions, applyRuleToProject,
  SEED_MAX_SF, RULE_MIN_CAP_SF,
  type Rule, type RuleShape,
} from "../src/lib/rules.ts";

// closed rectangle as flat boundary segments (image px)
function rectSegs(x0: number, y0: number, x1: number, y1: number): number[] {
  return [
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ];
}
const rectRing = (x0: number, y0: number, x1: number, y1: number): Point[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const norm = (ring: Point[], w: number, h: number): Point[] => ring.map(([x, y]) => [x / w, y / h]);

// ── the synthetic sheet ──────────────────────────────────────────────────────
// 1000×800 img px, upp 0.1 ft/px (so 40 px = 4 ft). Two rooms:
//   A (50,50)-(450,750)  with column a  (200,300)-(240,340)
//   B (550,50)-(950,750) with column b  (700,300)-(740,340)
//     and an OPEN box     (800,500)-(840,540) — bottom wall missing, so its
//     interior connects to the room field and must never be proposed.
const IMG_W = 1000, IMG_H = 800, UPP = 0.1;
const segs = [
  ...rectSegs(50, 50, 450, 750),
  ...rectSegs(200, 300, 240, 340),
  ...rectSegs(550, 50, 950, 750),
  ...rectSegs(700, 300, 740, 340),
  // open box: top, left, right — no bottom
  800, 500, 840, 500,
  800, 500, 800, 540,
  840, 500, 840, 540,
];
const mask = buildMask(segs, IMG_W, IMG_H);

const roomA: RuleShape = { id: "shp-roomA", sheet_id: "S1", condition_id: "C1", measure_role: "floor_area", verts_norm: norm(rectRing(50, 50, 450, 750), IMG_W, IMG_H), computed: { area_sf: 2800 } };
const roomB: RuleShape = { id: "shp-roomB", sheet_id: "S1", condition_id: "C1", measure_role: "floor_area", verts_norm: norm(rectRing(550, 50, 950, 750), IMG_W, IMG_H), computed: { area_sf: 2800 } };
// the estimator's correction: a deduct hand-drawn over column a (slightly loose)
const seedDeduct: RuleShape = { id: "shp-seed", sheet_id: "S1", condition_id: "C1", measure_role: "deduct", verts_norm: norm(rectRing(198, 298, 242, 342), IMG_W, IMG_H), computed: { area_sf: 19.4 } };

const sheetData = new Map([["S1", { mask, upp: UPP, imgW: IMG_W, imgH: IMG_H }]]);

test("ringContains: full containment true, overlap/outside false", () => {
  const outer = rectRing(0, 0, 100, 100);
  assert.equal(ringContains(outer, rectRing(20, 20, 40, 40)), true);
  assert.equal(ringContains(outer, rectRing(80, 80, 120, 120)), false);
  assert.equal(ringContains(outer, rectRing(200, 200, 220, 220)), false);
});

test("defaultMaxAreaSf: floors at the RFC's 25 SF, rounds bigger seeds up to 5", () => {
  assert.equal(defaultMaxAreaSf(4), RULE_MIN_CAP_SF);
  assert.equal(defaultMaxAreaSf(25), 25);
  assert.equal(defaultMaxAreaSf(26), 30);
  assert.equal(defaultMaxAreaSf(60), 60);
  assert.equal(defaultMaxAreaSf(61), 65);
});

test("detectCandidateRule: deduct inside same-condition room on same sheet fires", () => {
  const hit = detectCandidateRule([roomA, roomB, seedDeduct], seedDeduct);
  assert.ok(hit);
  assert.equal(hit.container_shape_id, "shp-roomA");
  assert.equal(hit.max_area_sf, RULE_MIN_CAP_SF); // 19.4 SF seed → 25 SF floor
  assert.equal(hit.seed_area_sf, 19.4);
});

test("detectCandidateRule: stays silent on the ambiguous cases", () => {
  // different condition — not this rule's scope
  const otherCond = { ...seedDeduct, id: "d2", condition_id: "C2" };
  assert.equal(detectCandidateRule([roomA, otherCond], otherCond), null);
  // different sheet
  const otherSheet = { ...seedDeduct, id: "d3", sheet_id: "S9" };
  assert.equal(detectCandidateRule([roomA, otherSheet], otherSheet), null);
  // not contained (straddles the room edge)
  const straddle = { ...seedDeduct, id: "d4", verts_norm: norm(rectRing(430, 300, 470, 340), IMG_W, IMG_H) };
  assert.equal(detectCandidateRule([roomA, straddle], straddle), null);
  // room-scale deduct — a boundary correction, not a column rule
  const huge = { ...seedDeduct, id: "d5", verts_norm: norm(rectRing(100, 100, 400, 500), IMG_W, IMG_H), computed: { area_sf: SEED_MAX_SF + 1 } };
  assert.equal(detectCandidateRule([roomA, huge], huge), null);
  // not a deduct at all
  assert.equal(detectCandidateRule([roomA, seedDeduct], roomA), null);
});

test("buildRuleFromSeed: traceable, plain-language, inactive nothing", () => {
  const seed = detectCandidateRule([roomA, seedDeduct], seedDeduct)!;
  const rule = buildRuleFromSeed(seedDeduct, seed, "CPT-1", { id: "rule-1", now: "2026-07-25T00:00:00.000Z" });
  assert.equal(rule.seed_shape_id, "shp-seed");
  assert.equal(rule.seed_condition_id, "C1");
  assert.equal(rule.predicate.kind, "enclosed_subpolygon_deduct");
  assert.equal(rule.predicate.max_area_sf, 25);
  assert.match(rule.label, /under 25 SF/);
  assert.match(rule.label, /CPT-1/);
  assert.equal(rule.active, true);
  assert.deepEqual(rule.applied_to, []);
});

test("findEnclosedRegions: finds the column island, skips the room field and the open box", () => {
  const ringB = rectRing(550, 50, 950, 750);
  const maxCells = Math.floor(25 / (UPP / mask.ws) ** 2); // 25 SF in mask cells
  const found = findEnclosedRegions(mask, ringB, maxCells);
  assert.equal(found.length, 1);
  const c = ringCentroid(found[0]);
  assert.ok(c[0] > 700 && c[0] < 740 && c[1] > 300 && c[1] < 340, `centroid ${c} should sit in column b`);
});

test("applyRuleToProject: propagates to the other room only, dedups the seeded one", () => {
  const seed = detectCandidateRule([roomA, roomB, seedDeduct], seedDeduct)!;
  const rule = buildRuleFromSeed(seedDeduct, seed, "CPT-1", { id: "rule-1", now: "2026-07-25T00:00:00.000Z" });
  const candidates = applyRuleToProject(rule, [roomA, roomB, seedDeduct], sheetData);
  // room A's column is already covered by the seed deduct; room B's is not
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.sheet_id, "S1");
  assert.equal(c.container_shape_id, "shp-roomB");
  assert.ok(c.area_sf > 10 && c.area_sf <= 25, `area ${c.area_sf} should be column-sized under the cap`);
  const cen = ringCentroid(c.verts_norm.map(([nx, ny]) => [nx * IMG_W, ny * IMG_H] as Point));
  assert.ok(cen[0] > 700 && cen[0] < 740 && cen[1] > 300 && cen[1] < 340, `centroid ${cen} should sit in column b`);
});

test("applyRuleToProject: idempotent — accepted candidates never re-propose", () => {
  const seed = detectCandidateRule([roomA, roomB, seedDeduct], seedDeduct)!;
  const rule = buildRuleFromSeed(seedDeduct, seed, "CPT-1", { id: "rule-1", now: "2026-07-25T00:00:00.000Z" });
  const first = applyRuleToProject(rule, [roomA, roomB, seedDeduct], sheetData);
  const committed: RuleShape = {
    id: "shp-propagated", sheet_id: first[0].sheet_id, condition_id: "C1",
    measure_role: "deduct", verts_norm: first[0].verts_norm, computed: { area_sf: first[0].area_sf },
  };
  const second = applyRuleToProject(rule, [roomA, roomB, seedDeduct, committed], sheetData);
  assert.equal(second.length, 0);
});

test("applyRuleToProject: inactive rules and unknown predicate kinds do nothing", () => {
  const seed = detectCandidateRule([roomA, roomB, seedDeduct], seedDeduct)!;
  const rule = buildRuleFromSeed(seedDeduct, seed, "CPT-1", { id: "rule-1", now: "2026-07-25T00:00:00.000Z" });
  assert.deepEqual(applyRuleToProject({ ...rule, active: false }, [roomA, roomB], sheetData), []);
  const alien = { ...rule, predicate: { kind: "layer_snap", max_area_sf: 25 } } as unknown as Rule;
  assert.deepEqual(applyRuleToProject(alien, [roomA, roomB], sheetData), []);
});

test("applyRuleToProject: sheets without data are skipped, not crashed on", () => {
  const seed = detectCandidateRule([roomA, roomB, seedDeduct], seedDeduct)!;
  const rule = buildRuleFromSeed(seedDeduct, seed, "CPT-1", { id: "rule-1", now: "2026-07-25T00:00:00.000Z" });
  const elsewhere: RuleShape = { ...roomB, id: "shp-roomC", sheet_id: "S2" };
  const candidates = applyRuleToProject(rule, [roomA, roomB, elsewhere, seedDeduct], sheetData);
  assert.equal(candidates.length, 1);   // still just room B — S2 has no mask data
});

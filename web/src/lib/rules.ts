// Correction rules (#88) — one correction, fifty rooms. Pure geometry, no DOM,
// no model in the loop: a rule is a DETERMINISTIC predicate re-run over the
// project, never a re-prompt.
//
// v1 covers the RFC's literal example and nothing speculative: an estimator
// draws a Cut Out (deduct) fully inside one of a condition's floor_area rooms
// — "columns are not finish area on this project". That correction becomes:
//
//   { kind: "enclosed_subpolygon_deduct", max_area_sf: N }
//
// "Apply to the other 49" then scans every OTHER room of the same condition
// for small enclosed sub-regions (linework islands — column boxes, shafts,
// casework) and returns them as CANDIDATE deducts. The caller stages those in
// an accept gate (dashed pencil, explicit Apply) — nothing here commits, and
// nothing is ever applied silently. Every candidate carries the container it
// was found in; the caller stamps rule_id + seed_shape_id provenance so every
// propagated shape traces back to the correction that seeded it.
//
// Scope guards (the RFC's "deltas are ambiguous" warning, applied):
//   - detection fires ONLY on a deduct fully contained in a same-condition
//     floor_area on the same sheet, and only when the deduct is small
//     (≤ SEED_MAX_SF) — a room-scale deduct is a boundary correction, not a
//     column rule, and proposing a rule from it would be noise;
//   - propagation finds only CLOSED linework islands (a region of free mask
//     cells that does NOT connect to the room's own field — door openings
//     connect, so open bays never match), under the rule's area cap;
//   - candidates overlapping ANY existing deduct are dropped — re-running a
//     rule is idempotent by construction.
//
// The mask machinery is One-Click Area's own (buildMask/traceRegion) — the
// same downscaled linework raster the estimator already trusts for tracing.

import { pointInPoly } from "./geometry.js";
import { ringArea, traceRegion, type MaskObj, type Point } from "./oneclick.ts";

export interface RulePredicate {
  kind: "enclosed_subpolygon_deduct";
  max_area_sf: number;
}

export interface Rule {
  id: string;
  created_at: string;
  seed_shape_id: string;      // the correction that generated this rule — traceability
  seed_condition_id: string;  // project-scoped: rules never outlive the project file
  predicate: RulePredicate;
  label: string;              // plain language, generated once at creation
  applied_to: string[];       // shape ids minted by this rule — audit trail, not a gate (overlap dedup is the gate)
  active: boolean;
}

// Minimal structural slice of a canvas/session shape this module reads.
export interface RuleShape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role: string;
  verts_norm: Point[];
  computed?: { area_sf?: number };
}

/** A deduct larger than this is a boundary correction, not a column rule —
 *  detection stays silent (proposing a bad rule is worse than proposing none). */
export const SEED_MAX_SF = 100;
/** Predicate floor — the RFC's literal "under 25 SF". A tiny seed still yields
 *  a usable cap; a bigger seed raises it (rounded up to 5 SF) so the rule
 *  catches its own seed's size class. */
export const RULE_MIN_CAP_SF = 25;

export const ringCentroid = (pts: Point[]): Point => {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
};

const inside = (p: Point, ring: Point[]) => pointInPoly(p[0], p[1], ring) as boolean;

/** Every vertex AND the centroid inside — cheap full-containment test that is
 *  exact for the convex cutouts this rule targets and conservative otherwise. */
export function ringContains(outer: Point[], innerRing: Point[]): boolean {
  if (outer.length < 3 || innerRing.length < 3) return false;
  return innerRing.every((v) => inside(v, outer)) && inside(ringCentroid(innerRing), outer);
}

export function defaultMaxAreaSf(seedAreaSf: number): number {
  return Math.max(RULE_MIN_CAP_SF, Math.ceil(seedAreaSf / 5) * 5);
}

export interface RuleCandidateSeed {
  container_shape_id: string;
  max_area_sf: number;
  seed_area_sf: number;
}

/** Did this just-committed deduct sit fully inside a same-condition floor_area
 *  room on its own sheet, small enough to read as a cutout correction?
 *  Returns the detected seed (container + derived cap) or null. */
export function detectCandidateRule(shapes: RuleShape[], deduct: RuleShape): RuleCandidateSeed | null {
  if (deduct.measure_role !== "deduct" || deduct.verts_norm.length < 3) return null;
  const seedArea = deduct.computed?.area_sf ?? 0;
  if (!(seedArea > 0) || seedArea > SEED_MAX_SF) return null;
  const container = shapes.find((s) =>
    s.id !== deduct.id &&
    s.measure_role === "floor_area" &&
    s.sheet_id === deduct.sheet_id &&
    s.condition_id === deduct.condition_id &&
    s.verts_norm.length >= 3 &&
    ringContains(s.verts_norm, deduct.verts_norm));
  if (!container) return null;
  return { container_shape_id: container.id, max_area_sf: defaultMaxAreaSf(seedArea), seed_area_sf: seedArea };
}

export function buildRuleFromSeed(
  deduct: RuleShape, seed: RuleCandidateSeed, conditionTag: string,
  mint: { id: string; now: string },
): Rule {
  return {
    id: mint.id,
    created_at: mint.now,
    seed_shape_id: deduct.id,
    seed_condition_id: deduct.condition_id,
    predicate: { kind: "enclosed_subpolygon_deduct", max_area_sf: seed.max_area_sf },
    label: `Exclude enclosed regions under ${seed.max_area_sf} SF in ${conditionTag} rooms`,
    applied_to: [],
    active: true,
  };
}

/** Enclosed linework islands inside `ringImgPx`: connected components of free
 *  mask cells (hard walls block — bit 1; hatch is transparent, or every tile
 *  cell would match) that do NOT touch the ring's own field component.
 *  Components are found by 4-connected BFS clipped to the ring; anything that
 *  reaches the room's open field (door bays, alcoves) merges with it and is
 *  skipped by the size cap. Returns traced rings in IMAGE px. */
export function findEnclosedRegions(mask: MaskObj, ringImgPx: Point[], maxCells: number, minCells = 4): Point[][] {
  const { mask: m, mw, mh, ws } = mask;
  if (ringImgPx.length < 3 || maxCells < minCells) return [];
  const ringMask: Point[] = ringImgPx.map(([x, y]) => [x * ws, y * ws]);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of ringMask) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
  const x1 = Math.min(mw - 1, Math.ceil(bx1)), y1 = Math.min(mh - 1, Math.ceil(by1));
  if (x1 <= x0 || y1 <= y0) return [];
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // 0 = unvisited, 1 = visited
  const seen = new Uint8Array(bw * bh);
  const isFree = (gx: number, gy: number) => !(m[gy * mw + gx] & 1) && inside([gx + 0.5, gy + 0.5], ringMask);
  const out: Point[][] = [];
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const li = (gy - y0) * bw + (gx - x0);
      if (seen[li] || !isFree(gx, gy)) { seen[li] = 1; continue; }
      // BFS this component (grid coords), capped — a component that exceeds
      // maxCells is the room's own field (or an open bay): mark and move on.
      const cells: number[] = [];
      const stack = [gx, gy];
      seen[li] = 1;
      let over = false;
      let cx0 = gx, cx1 = gx, cy0 = gy, cy1 = gy;
      while (stack.length) {
        const cy = stack.pop() as number, cx = stack.pop() as number;
        cells.push(cx, cy);
        if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
        if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
        if (!over && cells.length / 2 > maxCells) over = true;
        const nbrs = [cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1];
        for (let k = 0; k < 8; k += 2) {
          const nx = nbrs[k], ny = nbrs[k + 1];
          if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
          const nli = (ny - y0) * bw + (nx - x0);
          if (seen[nli]) continue;
          seen[nli] = 1;
          if (isFree(nx, ny)) { stack.push(nx, ny); }
          // over-cap components keep flooding so the whole field is consumed
          // in ONE component instead of fragmenting into false positives.
        }
      }
      const n = cells.length / 2;
      if (over || n > maxCells || n < minCells) continue;
      // thickness guard — a 1-cell-wide sliver is linework noise, not a column
      if (cx1 - cx0 + 1 < 2 || cy1 - cy0 + 1 < 2) continue;
      // trace on a cropped canvas (components are small by the cap), then
      // shift back: traceRegion divides by ws, so offset in image px.
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
      const region = new Uint8Array(cw * ch);
      for (let k = 0; k < cells.length; k += 2) region[(cells[k + 1] - cy0) * cw + (cells[k] - cx0)] = 1;
      const ring = traceRegion({ region, mw: cw, mh: ch, ws }).map(([px, py]) => [px + cx0 / ws, py + cy0 / ws] as Point);
      if (ring.length >= 3) out.push(ring);
    }
  }
  return out;
}

export interface SheetRuleData {
  mask: MaskObj;
  upp: number;   // units (ft) per image px
  imgW: number;
  imgH: number;
}

export interface RuleCandidate {
  sheet_id: string;
  container_shape_id: string;
  verts_norm: Point[];
  area_sf: number;
}

/** Re-run the rule across the project: every floor_area room of the rule's
 *  condition (on sheets the caller has data for), minus anything an existing
 *  deduct already covers. Returns candidates only — the caller owns the
 *  stage → accept gate and all provenance stamping. Deterministic: same
 *  inputs, same candidates, every run. */
export function applyRuleToProject(
  rule: Rule, shapes: RuleShape[], sheetData: Map<string, SheetRuleData>,
): RuleCandidate[] {
  if (!rule.active || rule.predicate.kind !== "enclosed_subpolygon_deduct") return [];
  const rooms = shapes.filter((s) =>
    s.measure_role === "floor_area" &&
    s.condition_id === rule.seed_condition_id &&
    s.verts_norm.length >= 3 &&
    sheetData.has(s.sheet_id));
  // dedup targets: every deduct on a sheet, any condition — if ink already
  // covers the island, proposing it again is noise, not thoroughness.
  const deductsBySheet = new Map<string, Point[][]>();
  for (const s of shapes) {
    if (s.measure_role !== "deduct" || s.verts_norm.length < 3) continue;
    const d = sheetData.get(s.sheet_id);
    if (!d) continue;
    const ring = s.verts_norm.map(([nx, ny]) => [nx * d.imgW, ny * d.imgH] as Point);
    let arr = deductsBySheet.get(s.sheet_id);
    if (!arr) { arr = []; deductsBySheet.set(s.sheet_id, arr); }
    arr.push(ring);
  }
  const out: RuleCandidate[] = [];
  const acceptedBySheet = new Map<string, Point[][]>();
  for (const room of rooms) {
    const d = sheetData.get(room.sheet_id)!;
    if (!(d.upp > 0)) continue;
    const ringImg = room.verts_norm.map(([nx, ny]) => [nx * d.imgW, ny * d.imgH] as Point);
    // mask-cell area in SF: one cell is (1/ws) img px on a side
    const cellSf = (d.upp / d.mask.ws) ** 2;
    const maxCells = Math.floor(rule.predicate.max_area_sf / cellSf);
    const found = findEnclosedRegions(d.mask, ringImg, maxCells);
    for (const ring of found) {
      const areaSf = ringArea(ring) * d.upp * d.upp;
      if (!(areaSf > 0) || areaSf > rule.predicate.max_area_sf) continue;
      const c = ringCentroid(ring);
      const existing = deductsBySheet.get(room.sheet_id) || [];
      const taken = acceptedBySheet.get(room.sheet_id) || [];
      const covered = (rings: Point[][]) => rings.some((r) => inside(c, r) || inside(ringCentroid(r), ring));
      if (covered(existing) || covered(taken)) continue;
      out.push({
        sheet_id: room.sheet_id,
        container_shape_id: room.id,
        verts_norm: ring.map(([x, y]) => [x / d.imgW, y / d.imgH] as Point),
        area_sf: +areaSf.toFixed(2),
      });
      let arr = acceptedBySheet.get(room.sheet_id);
      if (!arr) { arr = []; acceptedBySheet.set(room.sheet_id, arr); }
      arr.push(ring);
    }
  }
  return out;
}

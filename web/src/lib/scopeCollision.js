// Scope collision (#366) — two conditions claiming the same floor, as a number
// that has to read zero. Pure, no React, no DOM; the SAME module the MCP
// verbs (scope_duplicates / scope_merge) and the canvas badge read, so a
// headless session and the app can never disagree about what is shared.
//
// The measurement: for every pair of committed floor_area shapes on one sheet,
// the exact polygon intersection (JTS overlay — the same library polyarr.ts
// builds the wall arrangement with), in square feet through that sheet's
// scale. A pair on DIFFERENT conditions is a collision: every total downstream
// counts that floor twice. A pair on the SAME condition is a double trace —
// a different bug, listed separately. Shared floor across the whole takeoff
// is Σ areas − area(union), counted once per cell of floor no matter how many
// shapes claim it (summing pairwise overlaps triple-counts a three-way pile;
// the room eval's batchMetrics learned this the hard way and this module
// keeps its rule).
//
// Deducts are not claims: a deduct subtracts, and a reconciled cut already
// lives inside its parent's holes. Only floor_area shapes are compared.
//
// Refusal over guessing: a ring the overlay cannot process (self-intersecting,
// degenerate) is repaired with buffer(0) once; if that still yields nothing the
// shape is reported in `unmeasured` with the reason and left out of every
// number — never silently counted as zero overlap.

import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import OverlayOp from "jsts/org/locationtech/jts/operation/overlay/OverlayOp.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import BufferOp from "jsts/org/locationtech/jts/operation/buffer/BufferOp.js";
import IsValidOp from "jsts/org/locationtech/jts/operation/valid/IsValidOp.js";
import { polyWithHolesMetrics } from "./geometry.js";

/** Symmetric IoU at or above this = the same space claimed twice. Pinned equal
 *  to the room eval's DUPLICATE_FRAC by test, so the harness's gate and the
 *  verb agree on the same set of pairs. */
export const SCOPE_DUPLICATE_IOU = 0.5;
/** Default listing floor: a pair whose shared floor is under this share of the
 *  smaller shape is a hairline (rings that kiss along a wall), not a claim. */
export const SCOPE_MIN_FRACTION = 0.05;
/** An overlap covering at least this share of the loser is near-total: the
 *  loser is the same space and goes, rather than keeping a sliver. */
export const SCOPE_NEAR_TOTAL = 0.98;

const gf = new GeometryFactory();
const round2 = (n) => Math.round(n * 100) / 100;

const ringPx = (verts, dims) => verts.map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
const closed = (pts) => gf.createLinearRing([...pts, pts[0]].map(([x, y]) => new Coordinate(x, y)));
const openRing = (coords) => coords.slice(0, coords.length - 1).map((c) => [c.x, c.y]);

/** A floor shape as a JTS polygon in sheet px, repaired once if invalid.
 *  Returns { poly } or { reason } — never a silently empty geometry. */
export function shapePolygon(shape, dims) {
  const verts = Array.isArray(shape?.verts_norm) ? shape.verts_norm.filter((v) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) : [];
  if (verts.length < 3) return { reason: "fewer than 3 vertices" };
  const holes = (Array.isArray(shape.verts_norm_holes) ? shape.verts_norm_holes : []).filter((h) => Array.isArray(h) && h.length >= 3);
  let poly;
  try {
    poly = gf.createPolygon(closed(ringPx(verts, dims)), holes.map((h) => closed(ringPx(h, dims))));
  } catch {
    return { reason: "ring could not be built" };
  }
  if (!IsValidOp.isValid(poly)) {
    try { poly = BufferOp.bufferOp(poly, 0); } catch { return { reason: "self-intersecting ring" }; }
    if (!poly || poly.isEmpty() || !(poly.getArea() > 0)) return { reason: "self-intersecting ring" };
  }
  if (!(poly.getArea() > 0)) return { reason: "zero area" };
  return { poly };
}

const bboxOf = (poly) => { const e = poly.getEnvelopeInternal(); return { x0: e.getMinX(), y0: e.getMinY(), x1: e.getMaxX(), y1: e.getMaxY() }; };
const envelopesTouch = (a, b) => !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);

/**
 * Every pair of floor shapes that share floor, per sheet, plus the whole
 * takeoff's shared-floor number.
 *
 * @param {any[]} shapes committed shapes (any role; only floor_area is compared)
 * @param {any[]} conditions the takeoff's conditions (finish tags for the rows)
 * @param {(sheetId: string) => ({w: number, h: number, upp: number} | null)} frameFor
 *   the sheet's px dims and feet-per-px; null = no scale / not loaded → shapes
 *   on that sheet are reported unmeasured
 * @param {{minFraction?: number}} [opts]
 */
export function scopeCollisions(shapes, conditions, frameFor, opts = {}) {
  const minFraction = Number.isFinite(opts.minFraction) ? Math.max(0, opts.minFraction) : SCOPE_MIN_FRACTION;
  const tagById = new Map((Array.isArray(conditions) ? conditions : []).map((c) => [c.id, c.finish_tag]));
  const bySheet = new Map();
  const unmeasured = [];
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (!s || s.measure_role !== "floor_area") continue;
    if (!bySheet.has(s.sheet_id)) bySheet.set(s.sheet_id, []);
    bySheet.get(s.sheet_id).push(s);
  }
  const collisions = [], duplicates = [], bySheetOut = [];
  let sharedTotal = 0;
  for (const [sheetId, list] of bySheet) {
    const frame = frameFor(sheetId);
    if (!frame || !(frame.upp > 0) || !(frame.w > 0) || !(frame.h > 0)) {
      for (const s of list) unmeasured.push({ shape_id: s.id, sheet_id: sheetId, reason: frame ? "sheet has no scale" : "sheet not loaded" });
      continue;
    }
    const sfPer = frame.upp * frame.upp;
    const entries = [];
    for (const s of list) {
      const r = shapePolygon(s, { w: frame.w, h: frame.h });
      if (!r.poly) { unmeasured.push({ shape_id: s.id, sheet_id: sheetId, reason: r.reason ?? "unmeasured" }); continue; }
      entries.push({ shape: s, poly: r.poly, bbox: bboxOf(r.poly), area: r.poly.getArea() });
    }
    // pairs — exact intersection, envelope-prefiltered so a sheet where most
    // rooms are far apart stays cheap
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i], B = entries[j];
        if (!envelopesTouch(A.bbox, B.bbox)) continue;
        let inter;
        try { inter = OverlayOp.overlayOp(A.poly, B.poly, OverlayOp.INTERSECTION); } catch { continue; }
        const shared = inter ? inter.getArea() : 0;
        if (!(shared > 0)) continue;
        const smaller = Math.min(A.area, B.area);
        const fraction = shared / smaller;
        if (fraction < minFraction) continue;
        const iou = shared / Math.max(1e-9, A.area + B.area - shared);
        const side = (e) => ({
          shape_id: e.shape.id, condition_id: e.shape.condition_id, condition: tagById.get(e.shape.condition_id) ?? "",
          ...(e.shape.label ? { label: e.shape.label } : {}),
          area_sf: round2(e.area * sfPer), reviewed: e.shape.origin?.reviewed === true,
        });
        const same = A.shape.condition_id === B.shape.condition_id;
        const pair = {
          sheet_id: sheetId, a: side(A), b: side(B),
          shared_sf: round2(shared * sfPer),
          fraction_of_smaller: round2(fraction * 100) / 100,
          iou: round2(iou * 100) / 100,
          same_condition: same,
          look: {
            x0: Math.floor(Math.min(A.bbox.x0, B.bbox.x0)), y0: Math.floor(Math.min(A.bbox.y0, B.bbox.y0)),
            x1: Math.ceil(Math.max(A.bbox.x1, B.bbox.x1)), y1: Math.ceil(Math.max(A.bbox.y1, B.bbox.y1)),
          },
        };
        (same ? duplicates : collisions).push(pair);
      }
    }
    // the sheet's shared floor: Σ areas − union, counted once per cell
    let sheetShared = 0;
    if (entries.length > 1) {
      try {
        const union = UnaryUnionOp.union(gf.createGeometryCollection(entries.map((e) => e.poly)));
        const sum = entries.reduce((n, e) => n + e.area, 0);
        sheetShared = Math.max(0, sum - union.getArea()) * sfPer;
      } catch {
        // a union the overlay refuses: fall back to the pairwise sum for THIS
        // sheet, disclosed, rather than a silent zero
        sheetShared = [...collisions, ...duplicates].filter((p) => p.sheet_id === sheetId).reduce((n, p) => n + p.shared_sf, 0);
        unmeasured.push({ shape_id: "", sheet_id: sheetId, reason: "union refused — sheet's shared floor is the pairwise sum" });
      }
    }
    bySheetOut.push({ sheet_id: sheetId, shared_floor_sf: round2(sheetShared) });
    sharedTotal += sheetShared;
  }
  const byBigger = (p, q) => q.shared_sf - p.shared_sf;
  collisions.sort(byBigger); duplicates.sort(byBigger);
  return { collisions, duplicates, shared_floor_sf: round2(sharedTotal), by_sheet: bySheetOut, unmeasured };
}

/** Pairs per condition id — the panel badge's count, both flavors. */
export function collisionsByCondition(result) {
  const out = new Map();
  const add = (id, pair) => { if (!out.has(id)) out.set(id, []); out.get(id).push(pair); };
  for (const p of result?.collisions ?? []) { add(p.a.condition_id, p); add(p.b.condition_id, p); }
  for (const p of result?.duplicates ?? []) { add(p.a.condition_id, p); }
  return out;
}

/**
 * The loser's remainder after the winner takes the shared floor: loser minus
 * winner as an exact boolean difference, in sheet px. Returns open rings the
 * way cutout.js does (outer + holes) with area/perim from the same
 * polyWithHolesMetrics every shape on the canvas is measured by — or null when
 * the difference is not ONE polygon (the loser would split, or vanish): that is
 * a re-trace decision, not a merge.
 */
export function subtractWinner(loser, winner, dims) {
  const L = shapePolygon(loser, dims), W = shapePolygon(winner, dims);
  if (!L.poly || !W.poly) return null;
  let diff;
  try { diff = OverlayOp.overlayOp(L.poly, W.poly, OverlayOp.DIFFERENCE); } catch { return null; }
  if (!diff || diff.isEmpty() || diff.getGeometryType() !== "Polygon") return null;
  const outer = openRing(diff.getExteriorRing().getCoordinates());
  if (outer.length < 3) return null;
  const holes = [];
  for (let i = 0; i < diff.getNumInteriorRing(); i++) {
    const h = openRing(diff.getInteriorRingN(i).getCoordinates());
    if (h.length >= 3) holes.push(h);
  }
  const m = polyWithHolesMetrics(outer, holes);
  if (!(m.area > 0)) return null;
  return { outer, holes, area: m.area, perim: m.perim };
}

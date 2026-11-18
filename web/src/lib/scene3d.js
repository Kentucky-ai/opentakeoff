// SPDX-License-Identifier: AGPL-3.0-only
// Based on Kevin Murphy's OpenTakeoff 3D takeoff view (knmurphy/opentakeoff feat/3d-takeoff-view,
// web/src/lib/scene3d.js). Copyright 2026 Kevin N. Murphy and the OpenTakeoff contributors,
// licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modified by Michael Edlin (Spline 3D viewer, 2026), ported back to OpenTakeoff under AGPL-3.0-only:
//   * the handedness fix — sheet y maps to world +Z (was −Z, a north-south mirror of the sheet);
//   * the condition model drives the render mode (flooring_type: base → vertical ribbon at the
//     condition's height_ft, transition / other linear → flush strip), no new extrude_* fields;
//   * counts render only when their condition has a height, at a real 2" post (was a 2-ft column);
//   * a free deduct of the same condition inside a floor is that floor's HOLE (the roll plan's
//     rule), not a red "excluded" volume; coplanar floors of different conditions STACK as layers;
//   * id Maps and a bbox grid replace the per-transition shapes.find (Kevin's P2 scaling note);
//   * surface_area runs stand as vertical ribbons at the condition's height;
//   * dropped: manufacturer textures, pastel / backdrop / grid toggles, section cut.
//
// Kevin's original header follows.
// Pure 3D scene builder — no three import, node:test-able. Doctrine:
// docs/superpowers/specs/2026-08-26-3d-takeoff-view-design.md.
// World mapping (pinned): [x_ft, height_up, +y_ft]. Image y grows DOWN and so
// does three's +Z as seen from the default north-up camera (above, screen-up =
// −Z), so the plan renders as itself, not its mirror image: x → screen right,
// y → screen down. Rings are still normalized on import (ringCCW outer / ringCW
// holes) so every consumer sees one winding. The renderer draws DoubleSide as
// insurance.

export const NOMINAL_THICKNESS_FT = 1 / 24; // floor slab visual thickness — display constant, not user data
export const NOMINAL_HEIGHT_FT = 3;         // unset post/ribbon HEIGHT nominal (tall dimension; never borrow the thickness nominal)
export const NOMINAL_BASE_FT = 4 / 12;      // a base condition with no height_ft: 4" (the common cove base), flagged nominal
export const EXCLUDED_COLOR = "#b03a26";    // ui.js SVG.danger literal
export const MITER_LIMIT = 4;               // miter offset × ribbon half-width before bevel fallback
export const RIBBON_HALF_FT = 1 / 24;       // vertical ribbon half-width
export const FLUSH_HALF_FT = 1 / 12;        // flush strip half-width
export const POST_RADIUS_FT = 1 / 12;       // a count with a height (corner guard): a 2" post, not Kevin's 2-ft column
export const STACK_GAP_FT = 1 / 96;         // between stacked layers, so two coplanar floors never z-fight

// feet → 7'-4½" (nearest ⅛"), the chip and export label
const EIGHTHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"];
export function ftIn(ft) {
  if (!Number.isFinite(ft)) return "";
  const e = Math.round(Math.abs(ft) * 96), f = Math.floor(e / 96), r = e - f * 96;
  return `${ft < 0 ? "-" : ""}${f}'-${Math.floor(r / 8)}${EIGHTHS[r % 8]}"`;
}

export function toWorldFt(verts_norm, sheet) {
  // `|| 0` folds IEEE-754 −0 to +0 — ny === 0 otherwise yields −0, which
  // assert/strict deepEqual (SameValue) distinguishes from 0 and fails tests.
  return (verts_norm || []).map(([nx, ny]) => [nx * sheet.widthPx * sheet.upp || 0, ny * sheet.heightPx * sheet.upp || 0]);
}

export function planPlane(sheet) {
  if (!(sheet.upp > 0)) throw new Error("Set the sheet scale first — 3D is feet-true or nothing.");
  const wFt = sheet.widthPx * sheet.upp;
  const hFt = sheet.heightPx * sheet.upp;
  return { wFt, hFt, cx: wFt / 2, cw: hFt / 2 };
}

export function worldWindingCCW(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a > 0;
}

export const ringCCW = (ring) => (worldWindingCCW(ring) ? ring : [...ring].reverse());
export const ringCW = (ring) => (worldWindingCCW(ring) ? [...ring].reverse() : ring);

export function centroid2(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / (ring.length || 1), y / (ring.length || 1)];
}
export function bbox2(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring || []) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
export function pointInRing2(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function ringAreaAbs(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
// a point strictly inside a ring (the centroid when it is inside, else the first interior sample)
export function interiorPoint(ring) {
  const c = centroid2(ring);
  if (pointInRing2(c[0], c[1], ring)) return c;
  const [x0, y0, x1, y1] = bbox2(ring);
  for (let k = 1; k < 8; k++) for (let j = 1; j < 8; j++) {
    const p = [x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * j) / 8];
    if (pointInRing2(p[0], p[1], ring)) return p;
  }
  return c;
}

// ── a uniform bbox grid — the O(n log n) replacement for "every item against every item" ──────
// items: [{ bbox:[x0,y0,x1,y1], ... }]; query(x, y) → the items whose bbox holds the point;
// queryBox(bb) → the items whose bbox overlaps bb. Cell size from the items' own median extent.
export function bboxGrid(items) {
  const list = (items || []).filter((it) => it.bbox && Number.isFinite(it.bbox[0]));
  if (!list.length) return { query: () => [], queryBox: () => [] };
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  const ext = [];
  for (const it of list) {
    const [a, b, c, d] = it.bbox;
    gx0 = Math.min(gx0, a); gy0 = Math.min(gy0, b); gx1 = Math.max(gx1, c); gy1 = Math.max(gy1, d);
    ext.push(Math.max(c - a, d - b));
  }
  ext.sort((p, q) => p - q);
  const cell = Math.max(ext[Math.floor(ext.length / 2)] || 1, (Math.max(gx1 - gx0, gy1 - gy0) || 1) / 512, 1e-9);
  const cells = new Map();
  const key = (i, j) => i * 1048576 + j;
  const ci = (x) => Math.floor((x - gx0) / cell), cj = (y) => Math.floor((y - gy0) / cell);
  for (const it of list) {
    const [a, b, c, d] = it.bbox;
    for (let i = ci(a); i <= ci(c); i++) for (let j = cj(b); j <= cj(d); j++) {
      const k = key(i, j);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(it);
    }
  }
  const query = (x, y) => (cells.get(key(ci(x), cj(y))) || []).filter((it) => x >= it.bbox[0] && x <= it.bbox[2] && y >= it.bbox[1] && y <= it.bbox[3]);
  const queryBox = (bb) => {
    const seen = new Set(), out = [];
    for (let i = ci(bb[0]); i <= ci(bb[2]); i++) for (let j = cj(bb[1]); j <= cj(bb[3]); j++) {
      for (const it of cells.get(key(i, j)) || []) {
        if (seen.has(it)) continue;
        seen.add(it);
        if (it.bbox[0] <= bb[2] && it.bbox[2] >= bb[0] && it.bbox[1] <= bb[3] && it.bbox[3] >= bb[1]) out.push(it);
      }
    }
    return out;
  };
  return { query, queryBox };
}

// ── condition → how it renders ────────────────────────────────────────────────────────
// No schema change: flooring_type / labor_class already say what a condition is.
const WALL_CLASSES = new Set(["wall", "thin_brick", "wall_tile"]);
export const isWallCondition = (c) => !!c && WALL_CLASSES.has(c.labor_class || "");
export const isBaseCondition = (c) => !!c && (c.flooring_type === "base" || /\bBASE\b/i.test(`${c.finish_tag || ""} ${c.name || ""}`) && c.flooring_type !== "transition");
// underlayment / sealer / prep layers sit UNDER the finish when two conditions share a footprint
const UNDER_RE = /UNDERLAY|GYP|PRIMER|SEALER|\bPREP\b|MEMBRANE|CUSHION|\bPAD\b|LEVEL|SKIM|MOISTURE|ACOUSTIC/i;
export const isUnderLayer = (c) => !!c && UNDER_RE.test(`${c.finish_tag || ""} ${c.name || ""}`);
export const heightOf = (s, c) => (s?.height_override === true ? Number(s.height_ft) || 0 : Number(s?.height_ft) || Number(c?.height_ft) || 0);

/**
 * Shapes on ONE sheet → slabs / ribbons / posts / notes, in world feet.
 *   shapes      the sheet's committed shapes (any condition, hidden ones filtered by the caller)
 *   conditions  the canvas conditions
 *   sheet       { widthPx, heightPx, upp } — the sheet's logical page size (sheetDims) and feet/px
 *   wallRunIds  Set of surface_area shape ids drawn elsewhere (skipped here; empty in OpenTakeoff)
 *   skipIds     Set of floor_area shape ids another layer draws (ceilings at their height)
 */
export function buildScene({ shapes, conditions, sheet, wallRunIds = new Set(), skipIds = new Set() }) {
  if (!(sheet.upp > 0)) throw new Error("Set the sheet scale first — 3D is feet-true or nothing.");
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const condOrder = new Map((conditions || []).map((c, i) => [c.id, i]));
  const slabs = [], ribbons = [], posts = [], notes = [];
  const noted = new Set(); // one note per (kind, tag)
  const note = (kind, tag, text, extra = {}) => {
    const key = `${kind}:${tag}`;
    if (noted.has(key)) return;
    noted.add(key);
    notes.push({ kind, tag, text, ...extra });
  };

  // ── floors first: rings, free deducts claimed as holes, stacking ──
  const floors = [];
  let wallFacesOnFloors = 0;
  for (const s of shapes || []) {
    if ((s.measure_role || "floor_area") !== "floor_area" || skipIds.has(s.id)) continue;   // skipIds: drawn by another layer (ceilings)
    const c = condById.get(s.condition_id);
    if (!c || (s.verts_norm || []).length < 3) continue;
    if (isWallCondition(c)) { wallFacesOnFloors++; continue; }   // a wall face drawn flat on an elevation — not a floor in plan
    const ring = toWorldFt(s.verts_norm, sheet);
    floors.push({ s, c, ring, bbox: bbox2(ring), holes: (s.verts_norm_holes || []).map((h) => toWorldFt(h, sheet)).filter((h) => h.length >= 3), claimed: [] });
  }
  if (wallFacesOnFloors) note("wall-faces-flat", "", `${wallFacesOnFloors} wall face${wallFacesOnFloors === 1 ? "" : "s"} drawn flat (an elevation region) — not placed in the plan's 3D; trace the wall as a Surface run to see it standing`);
  const floorGrid = bboxGrid(floors);
  for (const s of shapes || []) {
    if (s.measure_role !== "deduct" || s.cuts_shape_id || (s.verts_norm || []).length < 3) continue;
    const c = condById.get(s.condition_id);
    if (!c) continue;
    const ring = toWorldFt(s.verts_norm, sheet);
    const [px, py] = interiorPoint(ring);
    // a free deduct of the SAME condition inside a floor is that floor's hole (the roll plan
    // bands around it and the commit takes its area off) — never a red volume the plan contradicts
    const host = floorGrid.query(px, py).find((f) => f.c.id === c.id && pointInRing2(px, py, f.ring));
    if (host) { host.claimed.push({ ring, id: s.id }); continue; }
    const vf = ringCCW(ring);
    const t = Number(c.thickness_in) > 0 ? c.thickness_in / 12 : NOMINAL_THICKNESS_FT;
    slabs.push({ verts_ft: vf, holes_ft: [], z0: 0, z1: t, color: EXCLUDED_COLOR, tag: c.finish_tag, kind: "excluded", shapeId: s.id, condId: c.id });
    note("excluded", c.finish_tag, "excluded area — see plan", { at: centroid2(vf) });
  }
  // stacking: a floor whose interior point lies inside an EARLIER floor of another condition sits on
  // top of it (a "GYP+UNDERLAY" ring under the "UNIT-LVT" ring of the same room). Under-layers
  // (underlayment / sealer / pad by name) go first, then the conditions' own order.
  const layerRank = (f) => (isUnderLayer(f.c) ? 0 : 1) * 1e6 + (condOrder.get(f.c.id) ?? 0);
  const ordered = floors.slice().sort((a, b) => layerRank(a) - layerRank(b));
  const placedGrid = [];
  const nominalTags = new Set();
  let stacked = 0;
  for (const f of ordered) {
    const t = Number(f.c.thickness_in) > 0 ? f.c.thickness_in / 12 : NOMINAL_THICKNESS_FT;
    const [px, py] = interiorPoint(f.ring);
    let z0 = 0;
    for (const g of placedGrid) {
      if (g.c.id === f.c.id || px < g.bbox[0] || px > g.bbox[2] || py < g.bbox[1] || py > g.bbox[3]) continue;
      if (pointInRing2(px, py, g.ring) && !g.holes.some((h) => pointInRing2(px, py, h))) z0 = Math.max(z0, g.z1 + STACK_GAP_FT);
    }
    if (z0 > 0) stacked++;
    f.z0 = z0; f.z1 = z0 + t;
    placedGrid.push(f);
    if (!(Number(f.c.thickness_in) > 0)) nominalTags.add(f.c.finish_tag);
  }
  if (nominalTags.size) note("nominal-thickness", "", `${nominalTags.size} floor condition${nominalTags.size === 1 ? " has" : "s have"} no thickness set — slabs drawn at a nominal ½" (${[...nominalTags].slice(0, 4).join(", ")}${nominalTags.size > 4 ? ", …" : ""})`);
  if (stacked) note("stacked", "", `${stacked} floor${stacked === 1 ? "" : "s"} share a footprint with another condition — shown stacked as layers (under-layers first)`);
  for (const f of floors) {
    slabs.push({
      verts_ft: ringCCW(f.ring),
      holes_ft: [...f.holes, ...f.claimed.map((h) => h.ring)].map((h) => ringCW(h)),
      z0: f.z0, z1: f.z1, color: f.c.color, tag: f.c.finish_tag, kind: "floor", shapeId: f.s.id, condId: f.c.id,
      claimedDeducts: f.claimed.map((h) => h.id),
    });
  }
  const slabByShape = new Map(slabs.filter((x) => x.kind === "floor").map((x) => [x.shapeId, x]));
  let wallLinesOnFlats = 0;
  const floorTopAt = (x, y) => {
    let top = null;
    for (const f of floorGrid.query(x, y)) if (pointInRing2(x, y, f.ring)) top = Math.max(top ?? 0, f.z1);
    return top;
  };

  for (const s of shapes || []) {
    const c = condById.get(s.condition_id);
    if (!c) continue; // orphan on dead condition — totals' convention
    // ×N never duplicates geometry — note per condition, hoisted ABOVE the role dispatch
    if ((c.multiplier || 1) > 1) note("xn", c.finish_tag, `${c.finish_tag}: ×${c.multiplier} applies at condition level (one copy drawn)`);
    const role = s.measure_role || "floor_area";
    if (role === "surface_area") {
      if (wallRunIds.has(s.id)) continue;                      // drawn by another layer
      const h = heightOf(s, c);
      if ((s.verts_norm || []).length < 2) continue;
      ribbons.push({ path_ft: nudgePath(toWorldFt(s.verts_norm, sheet), -RIBBON_HALF_FT / 2), z0: 0, z1: h > 0 ? h : NOMINAL_HEIGHT_FT, side: "center",
        color: c.color, tag: c.finish_tag, mode: "vertical", shapeId: s.id, condId: c.id, derived: false, translucent: !(h > 0) });
      if (!(h > 0)) note("unset-height", c.finish_tag, `${c.finish_tag} has no height set — shown at nominal`);
      continue;
    }
    if (role === "linear") {
      if ((s.verts_norm || []).length < 2) continue;
      if (isWallCondition(c)) { wallLinesOnFlats++; continue; }   // a trim run measured on an elevation — it belongs to that wall, not the plan
      const derived = !!s.origin?.derived;
      const raw = toWorldFt(s.verts_norm, sheet);
      if (isBaseCondition(c)) {
        const h = heightOf(s, c);
        // Interior offset (Kevin's Web3D B9): a derived run is the floor's own boundary — offset it INTO
        // the room so it does not sit coincident with the slab edge. A derived base is an OPEN
        // run with its door gaps (derive_base), so it is nudged toward its source room
        // rather than inset as a closed ring. Hand-traced runs center on the path, nudged so a base and
        // a wainscot sharing one wall line never share literal coordinates.
        const host = derived ? slabByShape.get(s.origin.derived.from_shape_id) : null;
        const path = host ? nudgePath(raw, sideToward(raw, host.verts_ft) * RIBBON_HALF_FT) : nudgePath(raw, RIBBON_HALF_FT / 2);
        const zf = host ? host.z1 : floorTopBeside(raw, floorTopAt) ?? 0;
        ribbons.push({ path_ft: path, z0: zf, z1: zf + (h > 0 ? h : NOMINAL_BASE_FT), side: host ? "interior" : "center",
          color: c.color, tag: c.finish_tag, mode: "vertical", kind: "base", shapeId: s.id, condId: c.id, derived, translucent: !(h > 0) });
        if (!(h > 0)) note("unset-height", c.finish_tag, `${c.finish_tag} has no height set — base shown at a nominal 4"`);
        continue;
      }
      // transitions and every other linear line: a flush strip on the higher adjoining floor
      const z0 = flushBase(s, raw, slabByShape, floorTopAt, c, note);
      const t = Number(c.thickness_in) > 0 ? c.thickness_in / 12 : NOMINAL_THICKNESS_FT;
      ribbons.push({ path_ft: raw, z0, z1: z0 + t, side: "center", color: c.color, tag: c.finish_tag, mode: "flush",
        kind: c.flooring_type === "transition" ? "transition" : "linear", shapeId: s.id, condId: c.id, derived, translucent: false });
      continue;
    }
    if (role === "count") {
      const h = heightOf(s, c);
      if (!(h > 0)) continue;             // only a count WITH a height stands up (corner guards) — GRDs, drains, boxes stay flat
      const pt = toWorldFt(s.verts_norm, sheet)[0];
      if (!pt) continue;
      posts.push({ pt_ft: pt, z0: 0, z1: h, color: c.color, tag: c.finish_tag, shapeId: s.id, condId: c.id, translucent: false });
    }
  }
  if (wallLinesOnFlats) note("wall-lines-flat", "", `${wallLinesOnFlats} line${wallLinesOnFlats === 1 ? "" : "s"} of a wall condition measured on an elevation — not placed in the plan's 3D`);
  return { slabs, ribbons, posts, notes };
}

// +1 when the room (ring) lies on the path's LEFT normal (nudgePath's positive side), else −1 —
// voted over the segments so one segment along a notch never flips the whole run
export function sideToward(path, ring) {
  let vote = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (!(L > 1e-6)) continue;
    const nx = -(by - ay) / L, ny = (bx - ax) / L, mx = (ax + bx) / 2, my = (ay + by) / 2, off = Math.min(0.5, L / 4);
    const l = pointInRing2(mx + nx * off, my + ny * off, ring), r = pointInRing2(mx - nx * off, my - ny * off, ring);
    if (l !== r) vote += (l ? 1 : -1) * L;
  }
  return vote < 0 ? -1 : 1;
}
// the highest floor top on either side of a line (samples a quarter foot off each segment)
function floorTopBeside(path, floorTopAt) {
  let top = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    const L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L, off = 0.25;
    for (const t of [0.25, 0.5, 0.75]) {
      const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
      for (const sg of [1, -1]) { const z = floorTopAt(mx + nx * off * sg, my + ny * off * sg); if (z != null) top = Math.max(top ?? 0, z); }
    }
  }
  return top;
}

// Higher of the adjoining slab tops for a flush strip: the derived transition's between_shape_ids
// (Map lookup, not a shapes.find per strip), else point samples along the line on both sides.
function flushBase(s, path, slabByShape, floorTopAt, c, note) {
  const ids = s.origin?.derived?.between_shape_ids;
  let top = 0;
  if (Array.isArray(ids)) for (const id of ids) { const sl = slabByShape.get(id); if (sl) top = Math.max(top, sl.z1); }
  if (!(top > 0)) top = floorTopBeside(path, floorTopAt) || 0;
  if (top > 0) return top;
  note("nominal-thickness", c.finish_tag, `${c.finish_tag} has no floor under it — strip sits at nominal`);
  return NOMINAL_THICKNESS_FT;
}

// Quad strip along an open path. θ = interior angle at a joint between the
// (prev→vertex) and (vertex→next) rays; miter length = halfWidth / sin(θ/2).
// A near-reversal drives θ→0 and the miter→∞; past MITER_LIMIT × halfWidth the
// joint bevels (each segment keeps its own normal offsets). Near-duplicate
// points collapse and zero-length segments drop BEFORE any normal math.
export function buildRibbon(pathFt, halfWidth) {
  const pts = [];
  for (const p of pathFt) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push(p);
  }
  const positions = [];
  if (pts.length < 2) return { positions };
  const segU = (i) => {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const off = (p, n) => [p[0] + n[0] * halfWidth, p[1] + n[1] * halfWidth];
  const leftN = (u) => [u[1], -u[0]];
  // Miter point at vertex i for uIn/uOut, or null to bevel. Valid only when
  // BOTH sides stay within the clamp (one-sided spikes are still spikes).
  const miter = (i, uIn, uOut) => {
    const cosT = -(uIn[0] * uOut[0] + uIn[1] * uOut[1]); // cos θ between the two rays
    const sinHalf = Math.sqrt(Math.max(0, (1 - cosT) / 2));
    if (sinHalf < 1e-6) return null;
    const len = halfWidth / sinHalf;
    if (len > MITER_LIMIT * halfWidth) return null;
    const nIn = leftN(uIn), nOut = leftN(uOut);
    let bx = nIn[0] + nOut[0], by = nIn[1] + nOut[1];
    const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
    return [pts[i][0] + bx * len, pts[i][1] + by * len];
  };
  // Per-segment end points (x,y pairs), mitered where the joint allows.
  const endPair = (i, u) => {
    const n = leftN(u);
    return [off(pts[i], n), off(pts[i], [-n[0], -n[1]])]; // [left, right]
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const u = segU(i);
    let aL, aR, bL, bR;
    if (i > 0) {
      const m = miter(i, segU(i - 1), u);
      if (m) { aL = m; aR = [2 * pts[i][0] - m[0], 2 * pts[i][1] - m[1]]; } // mirror through the vertex
      else { [aL, aR] = endPair(i, u); }
    } else { [aL, aR] = endPair(0, u); }
    if (i < pts.length - 2) {
      const m = miter(i + 1, u, segU(i + 1));
      if (m) { bL = m; bR = [2 * pts[i + 1][0] - m[0], 2 * pts[i + 1][1] - m[1]]; }
      else { [bL, bR] = endPair(i + 1, u); }
    } else { [bL, bR] = endPair(i + 1, u); }
    positions.push(aL[0], aL[1], bL[0], bL[1], bR[0], bR[1],
                   aL[0], aL[1], bR[0], bR[1], aR[0], aR[1]); // 2 triangles (DoubleSide covers orientation)
  }
  return { positions };
}

// Interior inset for derived base rings: ringCCW-normalized rings are CCW in
// world, so the interior lies LEFT of each directed edge; inward normal =
// rotate the edge direction +90°: n = (−uy, ux). Each vertex moves along the
// bisector of its two adjacent inward edge normals, clamped to the plain edge
// normal when degenerate (reflex corners) — a bounded inset, never a spike.
// (Kevin's comment above describes the pre-fix −y frame; after the handedness fix a CCW ring in
// (x, +y-down) world has its interior on the same side the formula below computes — pinned by
// web/test/scene3d.test.ts "derived base inset lands inside the room".)
export function insetRing(ring, dist) {
  const r = ringCCW(ring);
  const n = r.length;
  const inward = (i) => {
    const a = r[i], b = r[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  return r.map((p, i) => {
    const nPrev = inward((i - 1 + n) % n), nNext = inward(i);
    let bx = nPrev[0] + nNext[0], by = nPrev[1] + nNext[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) { bx = nNext[0]; by = nNext[1]; } else { bx /= bl; by /= bl; }
    return [p[0] + bx * dist, p[1] + by * dist];
  });
}

// Deterministic lateral nudge so two ribbons sharing one wall line (e.g. a
// hand-traced base + a wainscot trace over the same snapped centerline) never
// occupy identical world coordinates (spec Web3D B9). Offsets every vertex
// along its edge's left normal by delta — sign is the caller's role choice.
export function nudgePath(path, delta) {
  return path.map((p, i) => {
    // The LAST vertex has no next segment — offset along the PRECEDING
    // segment's left normal (cycle-3 bug: with b === p the direction was the
    // zero vector and the endpoint never moved; a 2-point wall run is the
    // common case and must separate at BOTH ends).
    const last = i === path.length - 1;
    const a = last ? path[i - 1] : p;
    const b = last ? p : path[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (-dy / l) * delta, p[1] + (dx / l) * delta];
  });
}

// ── Picking — ranges on merged meshes (Kevin's spec addendum r4 rev 3, part A) ─
// addMesh merges each batch's per-item geometries into one mesh; buildShapeRanges records where
// each source item landed in the merged, NON-INDEXED vertex buffer so a raycast faceIndex resolves
// back to the item. The port widens the key from a shapeId to any pick id ("face:…", "edge:…",
// "lane:…") — the range walk is unchanged. Non-indexed only: faceIndex×3 → vertex ordinal →
// range membership holds ONLY when every triangle's 3 vertices are unique entries.
export function assertNonIndexed(geometry, where) {
  if (geometry.index) throw new Error(`${where || "scene3d"}: indexed geometry unsupported (buildShapeRanges/resolveShapeAt assume non-indexed)`);
}

export function buildShapeRanges(items) {
  const ranges = [];
  let start = 0;
  for (const { shapeId, geometry } of items) {
    assertNonIndexed(geometry, "buildShapeRanges");
    const count = geometry.attributes.position.count;
    ranges.push({ shapeId, start, count });
    start += count;
  }
  return ranges;
}

// faceIndex×3 is the ordinal of a face's FIRST vertex in the merged buffer; outside every range →
// null, a guaranteed miss rather than a wrong hit.
export function resolveShapeAt(ranges, faceIndex) {
  const ordinal = faceIndex * 3;
  for (const r of ranges) {
    if (ordinal >= r.start && ordinal < r.start + r.count) return r.shapeId;
  }
  return null;
}

// Planar UVs in feet (Kevin's uvPlanar, kept with the fix's sign): u = x, v = −w so v grows toward
// sheet NORTH and an image with the default flipY reads upright from the north-up camera. The
// port uses it for the tile grout grid on floors: period = tile + joint.
export function uvPlanar(ptsFt, periodFt, periodVFt) {
  const p = periodFt || 1, q = periodVFt || p;
  return ptsFt.map(([x, w]) => [x / p, -w / q || 0]);
}

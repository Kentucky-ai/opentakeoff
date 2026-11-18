// SPDX-License-Identifier: AGPL-3.0-only
// Based on Kevin Murphy's OpenTakeoff 3D takeoff view (knmurphy/opentakeoff feat/3d-takeoff-view,
// web/src/lib/scene3dScope.js). Copyright 2026 Kevin N. Murphy and the OpenTakeoff contributors,
// licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modified by Michael Edlin (Spline 3D viewer, 2026), ported back to OpenTakeoff under AGPL-3.0-only:
//   * SPEED — Kevin measured isolate3D at 1,627 ms for 2,000 rooms: every
//     unattributed shape was tested against every floor's outset ring, and the room walk used
//     shapes.find. Here an id Map and a bbox grid over the outset rings (lib/scene3d.js bboxGrid)
//     make each point test touch only the floors whose box holds it. Same answers — Kevin's
//     membership cases are pinned unchanged in web/test/scene3d.test.ts.
//   * isolateRooms(roomIds, …) is the membership walk on its own, so a UNIT (several rooms) isolates
//     the same way a room does; unitRoomsOf picks the unit's rooms (lib docs below).
//
// Kevin's original header follows.
// Room membership for selection isolation (spec addendum 2026-08-26e, r5 rev 2).
// isolate3D(selectedId, shapes) — signature unchanged. All membership math runs in NORMALIZED
// verts space (scale-free, no upp).
import { pointInPoly } from "./geometry.js";
import { insetRing, centroid2, bboxGrid } from "./scene3d.js";

const RUN_SAMPLE_FRACTION = 0.6; // ≥60% of samples decides join/drop for runs
const INTERIOR_SAMPLES_PER_SEGMENT = 8;
const CONNECT_OUTSET = 0.08;

// v0 (pre-r5) isolation, kept verbatim as the honest-scope fallback: a
// selected shape's room = itself, shapes whose origin.derived reaches it,
// and label-equal siblings. Everything else — including every unlinked,
// unlabeled shape — stays visible (it can't be attributed).
function legacyIsolate(selectedId, shapes, sel) {
  const vis = new Set([selectedId]);
  for (const s of shapes) {
    const d = s.origin?.derived;
    const linked = d && (d.from_shape_id === selectedId || (Array.isArray(d.between_shape_ids) && d.between_shape_ids.includes(selectedId)));
    if (linked) vis.add(s.id);
    else if (s.label && sel.label && s.label === sel.label) vis.add(s.id);
    else if (!s.origin?.derived && !s.label) vis.add(s.id); // unlinked: stays
  }
  return vis;
}

// The selected shape's room(s) — a SET (a transition reaches two floors).
function resolveRoomFloors(sel, byId) {
  const rooms = new Set();
  if ((sel.measure_role || "floor_area") === "floor_area") { rooms.add(sel.id); return rooms; }
  const d = sel.origin?.derived;
  if (!d) return rooms;
  const candidateIds = [];
  if (d.from_shape_id) candidateIds.push(d.from_shape_id);
  if (Array.isArray(d.between_shape_ids)) candidateIds.push(...d.between_shape_ids);
  for (const id of candidateIds) {
    const f = byId.get(id);
    if (f && (f.measure_role || "floor_area") === "floor_area") rooms.add(f.id);
  }
  return rooms;
}

// Derived links + label equality, walked FROM the resolved room floors. Graph admission takes
// PRECEDENCE over membership.
function graphAdmits(shape, roomIds, roomLabels) {
  const d = shape.origin?.derived;
  if (d) {
    if (d.from_shape_id && roomIds.has(d.from_shape_id)) return true;
    if (Array.isArray(d.between_shape_ids) && d.between_shape_ids.some((id) => roomIds.has(id))) return true;
  }
  return !!(shape.label && roomLabels.has(shape.label));
}

// Outward ring push so containment reaches PAST the wall line. eps = 1% of the ring's own bbox
// min dimension. <3-vertex or degenerate ring → no ring, degrade rather than throw.
function outsetRingFor(shape, factor = 0.01) {
  const ring = shape.verts_norm;
  if (!ring || ring.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const minDim = Math.min(maxX - minX, maxY - minY);
  if (!(minDim > 0)) return null;
  return insetRing(ring, -factor * minDim);
}

// The floor index: every floor_area's outset ring with its bbox, in a grid. contains(x, y) lists
// the floors (other than excludeId) whose outset holds the point and none of whose RAW holes do.
function floorIndex(shapes, factor = 0.01) {
  const items = [];
  for (const s of shapes) {
    if ((s.measure_role || "floor_area") !== "floor_area") continue;
    const outset = outsetRingFor(s, factor);
    if (!outset) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of outset) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    items.push({ id: s.id, floor: s, outset, bbox: [x0, y0, x1, y1] });
  }
  const grid = bboxGrid(items);
  return {
    containing(x, y, excludeId) {
      const hits = [];
      for (const it of grid.query(x, y)) {
        if (it.id === excludeId || !pointInPoly(x, y, it.outset)) continue;
        const holes = it.floor.verts_norm_holes || [];
        if (holes.some((h) => h.length >= 3 && pointInPoly(x, y, h))) continue;
        hits.push(it.id);
      }
      return hits;
    },
    items,
    grid,
  };
}

// Floors are disjoint: overlap with the resolved room's outset (nested or wall-shared) is the ONLY
// way an unlinked floor joins or stays; hitting no room at all means it is another room — drop.
function classifyFloorRing(shape, idx, roomIds) {
  const ring = shape.verts_norm || [];
  if (ring.length === 0) return "drop";
  const [cx, cy] = centroid2(ring);
  if (pointInPoly(cx, cy, ring)) {
    const hits = idx.containing(cx, cy, shape.id);
    if (hits.some((id) => roomIds.has(id))) return hits.length > 1 ? "stay" : "join";
    return "drop";
  }
  let inResolved = 0, overlap = 0;
  for (const [x, y] of ring) {
    const hits = idx.containing(x, y, shape.id);
    if (hits.some((id) => roomIds.has(id))) { inResolved++; if (hits.length > 1) overlap++; }
  }
  if (inResolved / ring.length >= RUN_SAMPLE_FRACTION) return overlap ? "stay" : "join";
  return "drop";
}

function classifyPoint(x, y, idx, roomIds, excludeId) {
  const hits = idx.containing(x, y, excludeId);
  if (hits.length !== 1) return "stay";
  return roomIds.has(hits[0]) ? "join" : "drop";
}

function classifyBySamples(samples, idx, roomIds, excludeId) {
  if (samples.length === 0) return "stay";
  let inResolved = 0, inOther = 0;
  for (const [x, y] of samples) {
    const hits = idx.containing(x, y, excludeId);
    if (hits.some((id) => roomIds.has(id))) inResolved++;
    if (hits.some((id) => !roomIds.has(id))) inOther++;
  }
  const n = samples.length;
  if (inResolved / n >= RUN_SAMPLE_FRACTION) return "join";
  if (inOther / n >= RUN_SAMPLE_FRACTION) return "drop";
  return "stay";
}

function classifyClosedRing(shape, idx, roomIds) {
  const ring = shape.verts_norm || [];
  if (ring.length === 0) return "stay";
  const [cx, cy] = centroid2(ring);
  if (pointInPoly(cx, cy, ring)) return classifyPoint(cx, cy, idx, roomIds, shape.id);
  return classifyBySamples(ring, idx, roomIds, shape.id);
}

function runSamples(path) {
  const samples = [...path];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    for (let k = 1; k <= INTERIOR_SAMPLES_PER_SEGMENT; k++) {
      const t = k / (INTERIOR_SAMPLES_PER_SEGMENT + 1);
      samples.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return samples;
}

function classifyShape(shape, idx, roomIds) {
  switch (shape.measure_role || "floor_area") {
    case "count": {
      const p = shape.verts_norm?.[0];
      return p ? classifyPoint(p[0], p[1], idx, roomIds, shape.id) : "stay";
    }
    case "deduct":
      return classifyClosedRing(shape, idx, roomIds);
    case "floor_area":
      return shape.label || shape.origin?.derived ? "drop" : classifyFloorRing(shape, idx, roomIds);
    case "linear":
    case "surface_area":
      return shape.origin?.derived ? "drop" : classifyBySamples(runSamples(shape.verts_norm || []), idx, roomIds, shape.id);
    default:
      return "drop";
  }
}

// The membership walk for a SET of room floors (a room, a transition's two rooms, a unit).
export function isolateRooms(roomIds, shapes, alsoIds = [], byId = null) {
  const map = byId || new Map(shapes.map((s) => [s.id, s]));
  const roomLabels = new Set();
  for (const id of roomIds) { const f = map.get(id); if (f?.label) roomLabels.add(f.label); }
  const vis = new Set([...alsoIds, ...roomIds]);
  const undecided = [];
  for (const s of shapes) {
    if (vis.has(s.id)) continue;
    if (graphAdmits(s, roomIds, roomLabels)) vis.add(s.id);
    else undecided.push(s);
  }
  const idx = floorIndex(shapes);
  for (const s of undecided) if (classifyShape(s, idx, roomIds) !== "drop") vis.add(s.id);
  return vis;
}

export function isolate3D(selectedId, shapes) {
  if (!selectedId) return null;
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const sel = byId.get(selectedId);
  if (!sel) return null;
  const roomIds = resolveRoomFloors(sel, byId);
  if (roomIds.size === 0) return legacyIsolate(selectedId, shapes, sel);
  return isolateRooms(roomIds, shapes, [selectedId], byId);
}

// ── a UNIT: the rooms a selection belongs to, as a set ───────────────────────────────────────
// 1. the condition's unit key — `unit_type` (e.g. "UNIT A1 x66") or `variant_label` —
//    every floor on the sheet whose condition carries the same key;
// 2. else the rooms CONNECTED to the selected room (outset rings overlapping, walked breadth-first)
//    whose condition has the same ×N multiplier — a unit plan's rooms share its count; a corridor
//    (×1) next to a ×22 unit does not join it.
// Returns { roomIds:Set, by:"unit_type"|"variant"|"connected", key } or null.
export function unitRoomsOf(selectedId, shapes, conditions) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const sel = byId.get(selectedId);
  if (!sel) return null;
  const cById = new Map((conditions || []).map((c) => [c.id, c]));
  const start = resolveRoomFloors(sel, byId);
  if (!start.size) return null;
  const first = byId.get([...start][0]);
  const c0 = cById.get(first.condition_id);
  const keyOf = (c) => (c?.unit_type ? ["unit_type", String(c.unit_type).trim()] : c?.variant_label ? ["variant", String(c.variant_label).trim()] : null);
  const k0 = keyOf(c0);
  const floors = shapes.filter((s) => (s.measure_role || "floor_area") === "floor_area" && s.sheet_id === first.sheet_id);
  if (k0) {
    const ids = new Set(floors.filter((s) => { const k = keyOf(cById.get(s.condition_id)); return k && k[0] === k0[0] && k[1] === k0[1]; }).map((s) => s.id));
    for (const id of start) ids.add(id);
    return { roomIds: ids, by: k0[0], key: k0[1] };
  }
  const mult = (s) => Math.max(1, Math.round(Number(cById.get(s.condition_id)?.multiplier) || 1));
  const m0 = mult(first);
  // rooms traced to their own wall faces sit a wall's thickness apart: reach 8% of each room's
  // narrow side (a 10-ft room → 0.8 ft) so a partition does not split the unit
  const idx = floorIndex(floors, CONNECT_OUTSET);
  const out = new Set(start), queue = [...start];
  while (queue.length) {
    const f = byId.get(queue.shift());
    for (const [x, y] of f.verts_norm || []) {
      for (const id of idx.containing(x, y, f.id)) {
        if (out.has(id) || mult(byId.get(id)) !== m0) continue;
        out.add(id); queue.push(id);
      }
    }
  }
  return { roomIds: out, by: "connected", key: `×${m0}` };
}

// The room a shape sits in when it is not a floor and not derived from one (a hand-traced wall
// run, a count): the floor whose outset holds most of its samples. Lets "isolate room" start from a
// wall face or a trim. null when no floor holds it.
export function hostRoomOf(shapeId, shapes) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const s = byId.get(shapeId);
  if (!s) return null;
  if ((s.measure_role || "floor_area") === "floor_area") return s.id;
  const linked = resolveRoomFloors(s, byId);
  if (linked.size) return [...linked][0];
  const idx = floorIndex(shapes, CONNECT_OUTSET);
  const pts = s.measure_role === "count" ? (s.verts_norm || []).slice(0, 1) : runSamples(s.verts_norm || []);
  const votes = new Map();
  for (const [x, y] of pts) for (const id of idx.containing(x, y, s.id)) votes.set(id, (votes.get(id) || 0) + 1);
  let best = null, bv = 0;
  for (const [id, v] of votes) if (v > bv) { best = id; bv = v; }
  return best;
}

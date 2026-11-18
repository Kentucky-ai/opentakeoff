// @ts-nocheck — the 3D libs are plain JS; these are behaviour pins, not type pins.
// 3D takeoff view (lib/scene3d*.js, lib/stairs.js): Kevin Murphy's builder cases on the fixed
// (+y) handedness, the camera / plan-skin math through three's own projection, stairs, tile grout
// grids, isolation and its speed — ported from Michael Edlin's Spline viewer tests to node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildScene, toWorldFt, planPlane, ringCCW, worldWindingCCW, buildRibbon, nudgePath, insetRing, bboxGrid, ftIn,
  NOMINAL_THICKNESS_FT, NOMINAL_BASE_FT, EXCLUDED_COLOR, MITER_LIMIT, RIBBON_HALF_FT, buildShapeRanges, resolveShapeAt, assertNonIndexed, uvPlanar,
} from "../src/lib/scene3d.js";
import { isolate3D, isolateRooms, unitRoomsOf, hostRoomOf } from "../src/lib/scene3dScope.js";
import { tileGridOf, groutColorOf } from "../src/lib/scene3dTile.js";
import { buildTakeoffScene } from "../src/lib/scene3dTakeoff.js";
import { buildStairLayer, stairFrame, stairCardOf, NOMINAL_RISER_IN } from "../src/lib/scene3dStairs.js";
import { flightRect, stairMetrics } from "../src/lib/stairs.js";
import { slabGeometry, ribbonGeometry, planSkinMesh, fitToContent, cameraPreset, quadsGeometry, barsGeometry, flatsGeometry } from "../src/lib/scene3dThree.js";

const ok = (c, m) => assert.ok(c, m);
const eq = (a, b, m) => assert.deepEqual(a, b, m);
const near = (a, b, m, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

const SHEET = { widthPx: 1000, heightPx: 2000, upp: 0.05 };
const COND = { id: "c1", finish_tag: "CPT-1", color: "#2f7d54", flooring_type: "carpet" };
const SQ_NORM = [[0, 0], [0.1, 0], [0.1, 0.05], [0, 0.05]];

// ── Kevin's builder cases, on the fixed (+y) mapping ─────────────────────────────────────────
test("toWorldFt / planPlane / winding (handedness fix)", () => {
  eq(toWorldFt(SQ_NORM, SHEET), [[0, 0], [5, 0], [5, 5], [0, 5]], "feet scale, y KEPT (+y = world +Z — a rotation, not a mirror)");
  eq(planPlane(SHEET), { wFt: 50, hFt: 100, cx: 25, cw: 50 }, "plan centred at +hFt/2");
  assert.throws(() => planPlane({ ...SHEET, upp: null }), /scale/i);
  const w = toWorldFt(SQ_NORM, SHEET);
  eq([worldWindingCCW(w), worldWindingCCW(ringCCW(w)), worldWindingCCW(ringCCW([...w].reverse()))], [true, true, true], "no reflection, so no flip; ringCCW normalizes");
  eq(ftIn(7 + 4 / 12), `7'-4"`, "ft-in label"); eq(ftIn(3.5 / 12), `0'-3½"`, "eighths");
});
test("floors: nominal / thickness / holes / deducts", () => {
  const f = { id: "f1", sheet_id: "a", condition_id: "c1", measure_role: "floor_area", verts_norm: SQ_NORM, computed: {} };
  let r = buildScene({ shapes: [f], conditions: [COND], sheet: SHEET });
  eq([r.slabs.length, r.slabs[0].z0, r.slabs[0].z1], [1, 0, NOMINAL_THICKNESS_FT], "nominal slab");
  ok(r.notes.some((x) => x.kind === "nominal-thickness"), "nominal note");
  r = buildScene({ shapes: [f], conditions: [{ ...COND, thickness_in: 0.5 }], sheet: SHEET });
  near(r.slabs[0].z1, 0.5 / 12, "thickness_in/12"); ok(!r.notes.some((x) => x.kind === "nominal-thickness"), "no note");
  const holed = { ...f, verts_norm_holes: [[[0.02, 0.01], [0.04, 0.01], [0.04, 0.02], [0.02, 0.02]]] };
  r = buildScene({ shapes: [holed], conditions: [COND], sheet: SHEET });
  eq(r.slabs[0].holes_ft.length, 1, "hole carried"); ok(!worldWindingCCW(r.slabs[0].holes_ft[0]), "hole wound opposite");
  const recon = { id: "d0", sheet_id: "a", condition_id: "c1", measure_role: "deduct", cuts_shape_id: "f1", verts_norm: SQ_NORM, computed: {} };
  eq(buildScene({ shapes: [f, recon], conditions: [COND], sheet: SHEET }).slabs.length, 1, "a reconciled cutout renders as nothing");
  // #354: a free deduct of the SAME condition inside the floor is its hole, never a red volume
  const own = { id: "d1", sheet_id: "a", condition_id: "c1", measure_role: "deduct", verts_norm: [[0.02, 0.01], [0.04, 0.01], [0.04, 0.02], [0.02, 0.02]], computed: {} };
  r = buildScene({ shapes: [f, own], conditions: [COND], sheet: SHEET });
  eq([r.slabs.length, r.slabs[0].holes_ft.length, r.slabs[0].claimedDeducts], [1, 1, ["d1"]], "claimed as a hole");
  const other = { ...own, id: "d2", verts_norm: [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6], [0.5, 0.6]] };
  r = buildScene({ shapes: [f, other], conditions: [COND], sheet: SHEET });
  const ex = r.slabs.find((s) => s.kind === "excluded");
  ok(ex && ex.color === EXCLUDED_COLOR, "a deduct outside its floor stays an excluded volume");
  // wall faces drawn flat on an elevation are not floors
  r = buildScene({ shapes: [{ ...f, condition_id: "w" }], conditions: [{ id: "w", finish_tag: "WT", labor_class: "wall", flooring_type: "ceramic" }], sheet: SHEET });
  eq([r.slabs.length, r.notes.some((x) => x.kind === "wall-faces-flat")], [0, true], "an elevation face is not a slab");
});
test("stacking: two conditions on one footprint are layers, under-layer first", () => {
  const conds = [{ id: "lvt", finish_tag: "UNIT-LVT A1", flooring_type: "lvt" }, { id: "gyp", finish_tag: "GYP+UNDERLAY-L2-3 A1", flooring_type: "lvt" }];
  const shapes = [{ id: "a", condition_id: "lvt", measure_role: "floor_area", verts_norm: SQ_NORM }, { id: "b", condition_id: "gyp", measure_role: "floor_area", verts_norm: SQ_NORM }];
  const r = buildScene({ shapes, conditions: conds, sheet: SHEET });
  const a = r.slabs.find((s) => s.shapeId === "a"), b = r.slabs.find((s) => s.shapeId === "b");
  eq(b.z0, 0, "the underlayment is on the floor");
  ok(a.z0 >= b.z1, "the LVT sits on it (never z-fights)");
});
test("base, transitions, counts (the condition model, no extrude_* fields)", () => {
  const conds = [
    { id: "f", finish_tag: "LVT-1", flooring_type: "lvt", thickness_in: 0.25 },
    { id: "g", finish_tag: "CPT-1", flooring_type: "carpet", thickness_in: 0.5 },
    { id: "rb", finish_tag: "RB-1", flooring_type: "base", height_ft: 4 / 12 },
    { id: "rb0", finish_tag: "RB-2", flooring_type: "base" },
    { id: "tr", finish_tag: "TRN-1", flooring_type: "transition" },
    { id: "cg", finish_tag: "CG-1", flooring_type: "accessory", height_ft: 4 },
    { id: "grd", finish_tag: "GRD", flooring_type: "accessory" },
  ];
  const A = [[0, 0], [0.1, 0], [0.1, 0.05], [0, 0.05]], B = [[0.1, 0], [0.2, 0], [0.2, 0.05], [0.1, 0.05]];
  const shapes = [
    { id: "fa", condition_id: "f", measure_role: "floor_area", verts_norm: A },
    { id: "fb", condition_id: "g", measure_role: "floor_area", verts_norm: B },
    { id: "b1", condition_id: "rb", measure_role: "linear", verts_norm: [[0, 0], [0.1, 0], [0.1, 0.05]], origin: { derived: { from_shape_id: "fa" } } },
    { id: "b2", condition_id: "rb0", measure_role: "linear", verts_norm: [[0, 0.05], [0.1, 0.05]] },
    { id: "t1", condition_id: "tr", measure_role: "linear", verts_norm: [[0.1, 0], [0.1, 0.05]], origin: { derived: { between_shape_ids: ["fa", "fb"] } } },
    { id: "t2", condition_id: "tr", measure_role: "linear", verts_norm: [[0.1, 0.01], [0.1, 0.04]] },
    { id: "p1", condition_id: "cg", measure_role: "count", verts_norm: [[0.05, 0.02]] },
    { id: "p2", condition_id: "grd", measure_role: "count", verts_norm: [[0.05, 0.02]] },
  ];
  const r = buildScene({ shapes, conditions: conds, sheet: SHEET });
  const b1 = r.ribbons.find((x) => x.shapeId === "b1"), b2 = r.ribbons.find((x) => x.shapeId === "b2");
  eq([b1.mode, b1.kind, b1.side], ["vertical", "base", "interior"], "derived base: a vertical ribbon on its room's side");
  near(b1.z1 - b1.z0, 4 / 12, "base height = the condition's height_ft");
  near(b1.z0, 0.25 / 12, "base stands on its floor");
  // nudged INTO room fa: the first segment runs along y=0 (north edge), the room is south (+y)
  ok(b1.path_ft[0][1] > 0, "derived base offset into the room (+y, south)");
  eq([b2.translucent, +(b2.z1 - b2.z0).toFixed(4)], [true, +NOMINAL_BASE_FT.toFixed(4)], "unset base height → nominal 4\", translucent");
  const t1 = r.ribbons.find((x) => x.shapeId === "t1"), t2 = r.ribbons.find((x) => x.shapeId === "t2");
  eq([t1.mode, t1.kind], ["flush", "transition"], "transition → flush strip");
  near(t1.z0, 0.5 / 12, "on the HIGHER of its two floors (id Map, not shapes.find)");
  near(t2.z0, 0.5 / 12, "hand-drawn transition: the higher floor by point samples");
  eq(r.posts.map((p) => p.shapeId), ["p1"], "only a count WITH a height stands up");
});
test("ribbon math (Kevin's): miter clamp, nudge every vertex, degenerate points", () => {
  const r = buildRibbon([[0, 0], [10, 0], [0.2, 0.05]], 0.05);
  const TOL = MITER_LIMIT * 0.05 + 1e-6, xs = r.positions.filter((_, i) => i % 2 === 0), ys = r.positions.filter((_, i) => i % 2 === 1);
  ok(Math.max(...xs) <= 10 + TOL && Math.min(...xs) >= -TOL && Math.max(...ys) <= 0.05 + TOL && Math.min(...ys) >= -TOL, "no miter spike");
  eq(nudgePath([[0, 0], [5, 0]], 0.02), [[0, 0.02], [5, 0.02]], "nudge moves the last vertex too");
  ok(buildRibbon([[0, 0], [0, 0], [5, 0], [5, 0]], 0.05).positions.every(Number.isFinite), "degenerate points filtered");
  const inset = insetRing([[0, 0], [10, 0], [10, 10], [0, 10]], 1);
  ok(inset.every(([x, y]) => x > 0 && x < 10 && y > 0 && y < 10), "insetRing lands inside the room on the fixed frame");
});
test("pick ranges (Kevin's): record + resolve, non-indexed only", () => {
  const g = (k) => ({ attributes: { position: { count: k } }, index: null });
  const ranges = buildShapeRanges([{ shapeId: "a", geometry: g(6) }, { shapeId: "face:x", geometry: g(3) }]);
  eq(ranges, [{ shapeId: "a", start: 0, count: 6 }, { shapeId: "face:x", start: 6, count: 3 }], "ranges accumulate");
  eq([resolveShapeAt(ranges, 0), resolveShapeAt(ranges, 1), resolveShapeAt(ranges, 2), resolveShapeAt(ranges, 3)], ["a", "a", "face:x", null], "faceIndex → pick id");
  assert.throws(() => assertNonIndexed({ index: {} }, "t"), /indexed/);
  eq(uvPlanar([[3, 4]], 1.5), [[2, -4 / 1.5]], "uvPlanar: v grows toward sheet north");
  const grid = bboxGrid([{ id: 1, bbox: [0, 0, 1, 1] }, { id: 2, bbox: [5, 5, 6, 6] }]);
  eq([grid.query(0.5, 0.5).map((x) => x.id), grid.query(5.5, 5.5).map((x) => x.id), grid.query(3, 3).length], [[1], [2], 0], "bbox grid");
});

// ── handedness: what the DEFAULT camera shows (the patch's four cases, three's own math) ─────
const H_SHEET = { widthPx: 2000, heightPx: 1000, upp: 0.05 };
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function renderDefault(extra = []) {
  const conds = [{ id: "cF", finish_tag: "CPT-1", color: "#2f7d54" }, { id: "cW", finish_tag: "WT-1", height_ft: 4 }, { id: "cP", finish_tag: "CG-1", height_ft: 4 }];
  const shapes = [
    { id: "ne", condition_id: "cF", measure_role: "floor_area", verts_norm: rect(0.7, 0.1, 0.9, 0.3) },
    { id: "sw", condition_id: "cF", measure_role: "floor_area", verts_norm: rect(0.1, 0.7, 0.3, 0.9) },
    { id: "wall", condition_id: "cW", measure_role: "surface_area", verts_norm: [[0.7, 0.1], [0.9, 0.1]], height_ft: 4 },
    { id: "post", condition_id: "cP", measure_role: "count", verts_norm: [[0.8, 0.2]] }, ...extra,
  ];
  const sc = buildScene({ shapes, conditions: conds, sheet: H_SHEET });
  const root = new THREE.Group(), mat = new THREE.MeshBasicMaterial(), byId = {};
  for (const s of sc.slabs) { const m = new THREE.Mesh(slabGeometry(s), mat); root.add(m); byId[s.shapeId] = m; }
  for (const r of sc.ribbons) { const m = new THREE.Mesh(ribbonGeometry(r, RIBBON_HALF_FT), mat); root.add(m); byId[r.shapeId] = m; }
  for (const p of sc.posts) { const o = new THREE.Object3D(); o.position.set(p.pt_ft[0], 0, p.pt_ft[1]); root.add(o); byId[p.shapeId] = o; }
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000);
  const controls = new OrbitControls(camera);
  fitToContent(camera, controls, root);
  camera.updateMatrixWorld(true);
  const ndc = (v) => v.clone().project(camera);
  const centerOf = (o) => { o.updateMatrixWorld(true); if (!o.geometry) return o.getWorldPosition(new THREE.Vector3()); o.geometry.computeBoundingBox(); return o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld); };
  return { camera, byId, ndc, centerOf, root, controls };
}
test("handedness: sheet north-east renders screen upper-right, south-west lower-left", () => {
  const { byId, ndc, centerOf } = renderDefault();
  const ne = ndc(centerOf(byId.ne)), sw = ndc(centerOf(byId.sw));
  ok(ne.x > 0.1 && ne.y > 0.1, `NE room at NDC (${ne.x.toFixed(2)}, ${ne.y.toFixed(2)}) — expected upper-right`);
  ok(sw.x < -0.1 && sw.y < -0.1, `SW room at NDC (${sw.x.toFixed(2)}, ${sw.y.toFixed(2)}) — expected lower-left`);
});
test("handedness: a wall on a room's north edge renders above it; a post inside stays inside", () => {
  const { byId, ndc, centerOf } = renderDefault();
  const room = ndc(centerOf(byId.ne)), c = centerOf(byId.wall), wall = ndc(new THREE.Vector3(c.x, 0, c.z)), post = ndc(centerOf(byId.post));
  ok(wall.y > room.y, "north wall above the room");
  ok(Math.abs(post.x - room.x) < 0.02 && Math.abs(post.y - room.y) < 0.02, "post at the room's centre");
});
test("handedness: the default camera looks straight down, screen-up = sheet north (−Z)", () => {
  const { camera } = renderDefault();
  ok(camera.getWorldDirection(new THREE.Vector3()).y < -0.99, "looking down");
  ok(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).z < -0.99, "screen-up is world −Z");
});
test("handedness: the plan skin puts each image pixel under the shape traced on it; title block reads upright", () => {
  const { ndc } = renderDefault();
  const mesh = planSkinMesh(H_SHEET, { width: 2000, height: 1000 });
  mesh.updateMatrixWorld(true);
  const flipY = mesh.material.map.flipY;
  const px = (x, z) => {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0)).intersectObject(mesh)[0];
    return [hit.uv.x * 2000, (flipY ? 1 - hit.uv.y : hit.uv.y) * 1000];
  };
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
  ok(close(px(80, 10), [1600, 200]), "NE room over its own pixels");
  ok(close(px(20, 40), [400, 800]), "SW room over its own pixels");
  const tl = ndc(new THREE.Vector3(0, 0, 0)), br = ndc(new THREE.Vector3(100, 0, 50));
  ok(tl.x < br.x && tl.y > br.y, "image top-left renders upper-left of its bottom-right (no mirror)");
});
test("camera presets: orbit from the south-east above; an elevation looks square at the face", () => {
  const { camera, controls, root } = renderDefault();
  cameraPreset("orbit", camera, controls, root);
  const d = camera.getWorldDirection(new THREE.Vector3());
  ok(d.y < -0.3 && d.x < 0 && d.z < 0, "orbit looks down, north-west");
  cameraPreset("elevation", camera, controls, root, { center: [80, 2, 5], normal: [0, 0, 1], width: 10, height: 4 });
  const e = camera.getWorldDirection(new THREE.Vector3());
  ok(e.z < -0.999, "looking straight at a south-facing face (−Z)");
});

test("tile: grout grid from tile_spec, the build-up, or the condition name", () => {
  const g = tileGridOf({ tile_spec: { nominal: { value: { w_in: 12, h_in: 24 } }, joint_in: { value: 0.125 }, pattern: { value: "horizontal stack" }, grout_color: { value: "Biscuit 14" } } });
  eq([g.wFt, g.hFt, g.pattern, g.from, g.grout.stated], [2, 1, "stacked", "documents", true], "12x24 horizontal stack");
  const b = tileGridOf({ buildup: [{ role: "finish", item: "Brand X 12x24 vertical offset" }, { role: "sundry", grout: { joint_in: 0.0625 } }] });
  eq([b.wFt, b.hFt, b.pattern, b.jointIn, /build-up/.test(b.from)], [1, 2, "running", 0.0625, true], "the build-up's size, labelled as such");
  const n2 = tileGridOf({ finish_tag: "PT-1", name: "Porcelain 24x24", flooring_type: "tile" });
  eq([n2.wFt, n2.hFt, /condition/.test(n2.from)], [2, 2, true], "an OpenTakeoff condition name states the size");
  eq(tileGridOf({ finish_tag: "CPT-1", name: "Carpet 24x24", flooring_type: "carpet" }), null, "a carpet tile name is not a grout grid");
  eq(tileGridOf({ finish_tag: "WT" }), null, "no size anywhere: no grid");
  eq(groutColorOf("Mapei Frost").stated, true, "grout words give a swatch");
});
test("three batches: quads / bars / flats are non-indexed with pick ranges", () => {
  const quads = [{ pickId: "a", pts: [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]], uv: [[0, 0], [4, 0], [4, 3], [0, 3]] }, { pickId: "b", pts: [[0, 0, 1], [4, 0, 1], [4, 3, 1], [0, 3, 1]], uv: [[0, 0], [4, 0], [4, 3], [0, 3]] }];
  const q = quadsGeometry(quads, [2.0104, 1.0104]);
  ok(!q.geometry.index && q.ranges.length === 2 && q.geometry.attributes.uv, "quads: non-indexed, ranged, UVs");
  const bars = [{ pickId: "n", a: [0, 1, 0], b: [4, 1, 0], half: 1 / 24 }, { pickId: "m", a: [0, 2, 0], b: [4, 2, 0], half: 1 / 24 }];
  eq(barsGeometry(bars).geometry.attributes.position.count, bars.length * 36, "a bar = 12 triangles");
  const f = flatsGeometry([{ pickId: "x", ring: [[0, 0], [4, 0], [4, 4], [0, 4]], holes: [[[1, 1], [2, 1], [2, 2], [1, 2]]], y: 0.1 }]);
  ok(f.geometry.attributes.position.count > 0 && f.ranges[0].shapeId === "x", "flat with a hole triangulates");
});
// ── isolation (Kevin's membership cases, then the speed) ──────────────────────────────────────
const sq = ([cx, cy], h) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
const ROOM_A = { id: "fA", label: "A", measure_role: "floor_area", verts_norm: [[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]] };
const ROOM_B = { id: "fB", label: "B", measure_role: "floor_area", verts_norm: [[0.2, 0], [0.4, 0], [0.4, 0.2], [0.2, 0.2]] };
const IN_A = [0.1, 0.1], IN_B = [0.3, 0.1], ON_WALL = [0.199, 0.1], NO_ROOM = [0.6, 0.6];
test("isolate3D: Kevin's membership cases, unchanged", () => {
  const legacy = [
    { id: "f1", label: "112", measure_role: "floor_area", verts_norm: [] },
    { id: "b1", label: "112", measure_role: "linear", verts_norm: [], origin: { derived: { from_shape_id: "f1" } } },
    { id: "f2", label: "114", measure_role: "floor_area", verts_norm: [] },
    { id: "w1", measure_role: "surface_area", verts_norm: [] },
  ];
  const v0 = isolate3D("f1", legacy);
  eq([v0.has("f1"), v0.has("b1"), v0.has("w1"), v0.has("f2"), isolate3D(null, legacy)], [true, true, true, false, null], "floor + derived + label; unlinked stays; other drops");
  const vis = (shape, extra = []) => isolate3D("fA", [ROOM_A, ROOM_B, shape, ...extra]).has(shape.id);
  eq(vis({ id: "d1", measure_role: "deduct", verts_norm: sq(IN_A, 0.02) }), true, "deduct in the room joins");
  eq(vis({ id: "d2", measure_role: "deduct", verts_norm: sq(IN_B, 0.02) }), false, "deduct in another room drops");
  eq(vis({ id: "d3", measure_role: "deduct", verts_norm: sq(ON_WALL, 0.001) }), true, "deduct on the shared wall stays");
  eq(vis({ id: "d4", measure_role: "deduct", verts_norm: sq(NO_ROOM, 0.02) }), true, "deduct in no room stays");
  eq(vis({ id: "fx", measure_role: "floor_area", verts_norm: sq(IN_B, 0.02) }), false, "unlabeled floor in another room drops");
  eq(vis({ id: "fy", measure_role: "floor_area", verts_norm: sq(IN_A, 0.02) }), true, "unlabeled floor in the room joins");
  eq(vis({ id: "l1", measure_role: "linear", verts_norm: sq(IN_B, 0.02), origin: { derived: { from_shape_id: "fA" } } }), true, "graph admission wins");
  eq([vis({ id: "c1", measure_role: "count", verts_norm: [IN_A] }), vis({ id: "c2", measure_role: "count", verts_norm: [IN_B] }), vis({ id: "c3", measure_role: "count", verts_norm: [ON_WALL] })], [true, false, true], "counts: join / drop / stay");
  eq([vis({ id: "r1", measure_role: "linear", verts_norm: [[0, 0.05], [0, 0.15]] }), vis({ id: "r2", measure_role: "surface_area", verts_norm: [[0.25, 0.05], [0.3, 0.05]] }), vis({ id: "r3", measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] }), vis({ id: "r4", measure_role: "surface_area", verts_norm: [] })], [true, false, true, true], "runs: own wall joins, other room drops, straddle stays, empty stays");
  const tr = { id: "tr1", measure_role: "linear", verts_norm: [[0.19, 0.19], [0.21, 0.19]], origin: { derived: { between_shape_ids: ["fA", "fB"] } } };
  const v2 = isolate3D("tr1", [ROOM_A, ROOM_B, tr, { id: "dA", measure_role: "deduct", verts_norm: sq(IN_A, 0.02) }, { id: "dB", measure_role: "deduct", verts_norm: sq(IN_B, 0.02) }]);
  eq([v2.has("dA"), v2.has("dB")], [true, true], "a transition resolves both rooms");
  const holed = { ...ROOM_A, verts_norm_holes: [[[0.198, 0.05], [0.2, 0.05], [0.2, 0.15], [0.198, 0.15]]] };
  eq(isolate3D("fA", [holed, ROOM_B, { id: "cH", measure_role: "count", verts_norm: [[0.199, 0.1]] }]).has("cH"), false, "a shape in the room's hole drops");
  const straddle = isolate3D("fa", [{ id: "fa", measure_role: "floor_area", verts_norm: sq([0.25, 0.25], 0.15) }, { id: "fb", measure_role: "floor_area", verts_norm: sq([0.55, 0.25], 0.15) }, { id: "fc", measure_role: "floor_area", verts_norm: sq([0.4, 0.25], 0.03) }]);
  eq([straddle.has("fb"), straddle.has("fc")], [false, true], "disjoint drops, straddler stays");
});
test("isolation: a unit (unit_type key, else connected rooms of the same ×N); a wall run's host room", () => {
  const conds = [{ id: "u1", unit_type: "UNIT A1 x66", multiplier: 66 }, { id: "u2", unit_type: "UNIT A1 x66", multiplier: 44 }, { id: "cor", multiplier: 1 }, { id: "k", multiplier: 2 }];
  const shapes = [
    { id: "a", sheet_id: "s", condition_id: "u1", measure_role: "floor_area", verts_norm: rect(0, 0, 0.1, 0.1) },
    { id: "b", sheet_id: "s", condition_id: "u2", measure_role: "floor_area", verts_norm: rect(0.1, 0, 0.2, 0.1) },
    { id: "c", sheet_id: "s", condition_id: "cor", measure_role: "floor_area", verts_norm: rect(0.2, 0, 0.3, 0.1) },
    { id: "w", sheet_id: "s", condition_id: "u1", measure_role: "surface_area", verts_norm: [[0.02, 0.02], [0.08, 0.02]] },
  ];
  const u = unitRoomsOf("a", shapes, conds);
  eq([u.by, [...u.roomIds].sort()], ["unit_type", ["a", "b"]], "the unit's rooms by unit_type");
  const v = isolateRooms(u.roomIds, shapes);
  eq([v.has("a"), v.has("b"), v.has("c"), v.has("w")], [true, true, false, true], "…and what is in them");
  // no key: rooms 0.5 ft apart (a partition) connect when the ×N matches
  const s2 = [
    { id: "x", sheet_id: "s", condition_id: "k", measure_role: "floor_area", verts_norm: rect(0, 0, 0.1, 0.1) },
    { id: "y", sheet_id: "s", condition_id: "k", measure_role: "floor_area", verts_norm: rect(0.105, 0, 0.2, 0.1) },
    { id: "z", sheet_id: "s", condition_id: "cor", measure_role: "floor_area", verts_norm: rect(0.205, 0, 0.3, 0.1) },
  ];
  const u2 = unitRoomsOf("x", s2, conds);
  eq([u2.by, [...u2.roomIds].sort()], ["connected", ["x", "y"]], "connected, same ×N");
  eq(hostRoomOf("w", shapes), "a", "a hand-traced wall run's room");
});
test("isolation speed: 2,000 rooms (Kevin measured 1,627 ms)", () => {
  const shapes = [];
  const N = 2000, G = Math.ceil(Math.sqrt(N)), step = 1 / G;
  for (let i = 0; i < N; i++) {
    const x = (i % G) * step, y = Math.floor(i / G) * step, h = step * 0.45, c = [x + step / 2, y + step / 2];
    shapes.push({ id: `f${i}`, measure_role: "floor_area", verts_norm: sq(c, h) });
    shapes.push({ id: `b${i}`, measure_role: "linear", verts_norm: sq(c, h), origin: { derived: { from_shape_id: `f${i}` } } });
    shapes.push({ id: `t${i}`, measure_role: "linear", verts_norm: [[c[0] + h, c[1]], [c[0] + h + 0.1 * step, c[1]]], origin: { derived: { between_shape_ids: [`f${i}`] } } });
    shapes.push({ id: `w${i}`, measure_role: "surface_area", verts_norm: [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h]] });
    shapes.push({ id: `c${i}`, measure_role: "count", verts_norm: [c] });
  }
  const t0 = performance.now();
  const v = isolate3D("f1000", shapes);
  const ms = performance.now() - t0;
  eq([v.has("f1000"), v.has("w1000"), v.has("c1000"), v.has("f999"), v.has("c999")], [true, true, true, false, false], "right answers at 10,000 shapes");
  ok(ms < 400, `isolate3D at 2,000 rooms in ${ms.toFixed(0)} ms (budget 400 ms on CI; Kevin's: 1,627)`);
});

// a 100' × 100' sheet: verts_norm × 100 = feet
const SSHEET = { widthPx: 1000, heightPx: 1000, upp: 0.1 };
const srect = (x0, y0, x1, y1) => [[x0 / 100, y0 / 100], [x1 / 100, y0 / 100], [x1 / 100, y1 / 100], [x0 / 100, y1 / 100]];
const cond = { id: "st", finish_tag: "RT-1", flooring_type: "stairs", color: "#335577" };
const shape = (id, verts, stair, label = "") => ({ id, sheet_id: "S", condition_id: "st", measure_role: "floor_area", verts_norm: verts, stair, label, computed: {} });

test("stairs: one straight flight: 16 treads @ 11' over 17 risers @ 7', 4' wide, on the floor", () => {
  const run = (16 * 11) / 12;
  const fl = shape("f1", srect(10, 10, 10 + run, 14), { kind: "flight", treads: 16, risers: 17, tread_in: 11, riser_in: 7, sides: ["wall", "open"], top_nosing: true });
  const L = buildStairLayer({ shapes: [fl], conditions: [cond], sheet: SSHEET, sheetId: "S" });
  const stair = L.quads.filter((q) => q.layer === "stair" && q.color === cond.color);
  eq(stair.length, 17 + 16, "17 risers + 16 treads drawn");
  eq(L.bars.length, 16 + 1, "a nosing per tread + the top landing's");
  near(L.topFt, (17 * 7) / 12, "climbs 17 × 7\" = 9'-11\"", 0.01);
  const zs = stair.flatMap((q) => q.pts.map((p) => p[1]));
  near(Math.min(...zs), 0, "starts on the floor");
  ok(L.quads.some((q) => q.layer === "context"), "the wall side is drawn as context");
  ok(L.quads.some((q) => q.layer === "stair" && q.color === "#6b6f76"), "the open side gets a stringer");
  eq(L.stairIds.has("f1"), true, "the flight is claimed (no flat slab)");
  ok(L.info.get("shape:f1").rows.some(([k, v]) => k === "Steps" && v === "16 treads · 17 risers"), "the chip states the card's counts");
  // the counts are the card's — the 3D never recounts
  const m = stairMetrics(fl.stair, flightRect(fl.verts_norm.map(([x, y]) => [x * 100, y * 100])));
  eq([m.treads, m.risers, m.nosing_count], [16, 17, 17], "stairMetrics agrees");
  // flipped: climbs the other way, same counts
  const F = buildStairLayer({ shapes: [{ ...fl, stair: { ...fl.stair, flip: true } }], conditions: [cond], sheet: SSHEET, sheetId: "S" });
  const lowRiser = (Q) => Q.quads.find((q) => q.layer === "stair" && q.pts.every((p) => p[1] <= 7 / 12 + 1e-9) && q.pts.some((p) => p[1] > 0));
  ok(Math.abs(lowRiser(L).pts[0][0] - lowRiser(F).pts[0][0]) > run - 0.5, "flip moves the bottom riser to the other end");
});

test("stairs: a U stair: flight · landing · flight — the landing and the second flight find their datums", () => {
  const f1 = shape("a", srect(0, 0, 10, 4), { kind: "flight", treads: 10, risers: 11, tread_in: 12, riser_in: 6, sides: ["wall", "wall"] }, "up 1");
  const land = shape("l", srect(10, 0, 14, 8.5), { kind: "landing" }, "mid landing");
  const f2 = shape("b", srect(0, 4.5, 10, 8.5), { kind: "flight", treads: 10, risers: 11, tread_in: 12, riser_in: 6, sides: ["wall", "wall"], flip: true }, "up 2");
  const L = buildStairLayer({ shapes: [f1, land, f2], conditions: [cond], sheet: SSHEET, sheetId: "S" });
  const landTop = L.quads.find((q) => q.shapeId === "l" && q.pts.every((p) => Math.abs(p[1] - q.pts[0][1]) < 1e-9) && q.pts[0][1] > 0);
  near(landTop.pts[0][1], (11 * 6) / 12, "the landing sits at the top of flight 1 (5'-6\")");
  near(L.topFt, (22 * 6) / 12, "flight 2 starts on the landing and arrives at 11'-0\"");
  ok(L.info.get("shape:b").rows.some(([k, v]) => k === "Climbs" && /mid landing/.test(v)), "flight 2 says it starts on the landing");
});

test("stairs: no riser height: drawn at the nominal and flagged; no counts: flat + flagged", () => {
  const a = shape("n1", srect(0, 0, 10, 4), { kind: "flight", treads: 10, tread_in: 12, sides: ["wall", "wall"] });
  const b = shape("n2", srect(20, 0, 30, 4), { kind: "flight", sides: ["wall", "wall"] });
  const L = buildStairLayer({ shapes: [a, b], conditions: [cond], sheet: SSHEET, sheetId: "S" });
  near(L.topFt, (11 * NOMINAL_RISER_IN) / 12, "nominal 7\" risers", 0.01);
  ok(L.notes.some((x) => /nominal/.test(x.text)), "…flagged");
  ok(L.notes.some((x) => /no tread count/.test(x.text)), "a flight with no counts is flagged");
});

test("stairs: the frame: a stair drawn on a rotated plan measures true", () => {
  const c = Math.cos(0.5), s = Math.sin(0.5);
  const ring = [[0, 0], [12, 0], [12, 4], [0, 4]].map(([x, y]) => [20 + x * c - y * s, 20 + x * s + y * c]);
  const st = { kind: "flight", treads: 12, tread_in: 12 };
  const f = stairFrame(ring, st, stairMetrics(st, flightRect(ring)));
  near(f.run, 12, "rotated run", 1e-6);
  near(f.width, 4, "rotated width", 1e-6);
});

test("stairs: in the scene: the stair replaces its flat slab", () => {
  const fl = shape("f9", srect(10, 10, 20, 14), { kind: "flight", treads: 10, risers: 11, tread_in: 12, riser_in: 7, sides: ["wall", "wall"] });
  const sc = buildTakeoffScene({ shapes: [fl], conditions: [cond], sheetId: "S", sheet: SSHEET });
  ok(!sc.slabs.some((x) => x.shapeId === "f9" && x.kind === "floor"), "no flat floor slab under a stair flight");
  ok(sc.stairs.quads.length > 0 && sc.info.has("shape:f9"), "the steps and their chip are in the scene");
});

test("stairs: OpenTakeoff marks a stair by its condition name and the plan note in the label", () => {
  const c = { id: "sc", finish_tag: "STAIR-1", name: "Rubber stair treads", color: "#335577" };
  const run = (13 * 11) / 12;
  const fl = { id: "s1", sheet_id: "S", condition_id: "sc", measure_role: "floor_area", verts_norm: srect(10, 10, 10 + run, 14), label: '13T @ 11" 14R @ 7"', computed: {} };
  const ld = { id: "s2", sheet_id: "S", condition_id: "sc", measure_role: "floor_area", verts_norm: srect(10 + run, 10, 14 + run, 14), label: "landing", computed: {} };
  const sc = buildTakeoffScene({ shapes: [fl, ld], conditions: [c], sheetId: "S", sheet: SSHEET });
  eq([sc.stats.flights, sc.stats.landings], [1, 1], "one flight, one landing");
  ok(sc.info.get("shape:s1").rows.some(([k, v]) => k === "Steps" && v === "13 treads · 14 risers"), "counts from the label");
  near(sc.stairs.topFt, (14 * 7) / 12, "climbs 14 × 7 in", 0.01);
  ok(!sc.slabs.some((s) => s.shapeId === "s1" || s.shapeId === "s2"), "neither is a flat slab");
  eq(stairCardOf({ label: "UP 12R" }, {}).risers, 12, "UP 12R reads as risers");
  eq(stairCardOf({ label: "" }, { finish_tag: 'STAIR-1 13T @ 11" 14R @ 7"' }).treads, 13, "the condition tag carries the note for every flight");
  eq(stairCardOf({ label: "" }, { finish_tag: "LANDING-1" }).kind, "landing", "a LANDING condition draws landings");
});

test("default path: the canvas never imports three or View3D statically", () => {
  const src = readFileSync(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url), "utf8");
  ok(!/from ["']three/.test(src) && !/import View3D/.test(src), "no static three / View3D import");
  ok(/import Lazy3D from "\.\.\/components\/Lazy3D\.jsx"/.test(src), "only the lazy doorway");
  ok(/<button name="view-3d"/.test(src), "one 3D button");
  const lazy = readFileSync(new URL("../src/components/Lazy3D.jsx", import.meta.url), "utf8");
  ok(/lazy\(\(\) => import\("\.\/View3D\.jsx"\)\)/.test(lazy), "View3D is a dynamic import");
});

import { buildCeilingLayer, ceilingHeightOf, parseFtIn, isCeilingCondition, CEILING_ALLOWANCE_FT } from "../src/lib/scene3dCeilings.js";
test("ceilings: drawn at their height, soffits drop to the ceiling around them, allowance flagged", () => {
  const CS = { widthPx: 1000, heightPx: 1000, upp: 0.1 };
  const r = (x0, y0, x1, y1) => [[x0 / 100, y0 / 100], [x1 / 100, y0 / 100], [x1 / 100, y1 / 100], [x0 / 100, y1 / 100]];
  const conds = [{ id: "act", finish_tag: "ACT-1", name: "2x4 acoustical ceiling", ceiling_ft: 9 }, { id: "gyp", finish_tag: "GYP CLG 8'-0\"" }, { id: "x", finish_tag: "ACT-2" }, { id: "lvt", finish_tag: "LVT-1" }];
  const shapes = [
    { id: "c1", condition_id: "act", measure_role: "floor_area", verts_norm: r(0, 0, 20, 20) },
    { id: "s1", condition_id: "gyp", measure_role: "floor_area", verts_norm: r(5, 5, 10, 10) },
    { id: "c2", condition_id: "x", measure_role: "floor_area", verts_norm: r(40, 0, 50, 10) },
    { id: "f1", condition_id: "lvt", measure_role: "floor_area", verts_norm: r(0, 0, 20, 20) },
  ];
  eq([isCeilingCondition(conds[0]), isCeilingCondition(conds[1]), isCeilingCondition(conds[3])], [true, true, false], "ACT / CLG are ceilings; LVT is not");
  near(parseFtIn("8'-6\" AFF"), 8.5, "RCP tag");
  eq(ceilingHeightOf({ ceiling_ft: 7.5 }, conds[0]).ft, 7.5, "the area's own height wins");
  const L = buildCeilingLayer({ shapes, conditions: conds, sheet: CS });
  const by = Object.fromEntries(L.slabs.map((s) => [s.shapeId, s]));
  eq([by.c1.z0, by.s1.z0, by.c2.z0], [9, 8, CEILING_ALLOWANCE_FT], "9' from the condition, 8' from the tag, the allowance otherwise");
  ok(by.c2.allowance && L.notes.some((n) => n.kind === "ceiling-allowance"), "the allowance is flagged");
  eq([by.c1.gridSpec.wFt, by.c1.gridSpec.hFt, by.c1.gridSpec.assumed], [2, 4, false], "2x4 grid from the name");
  const drops = L.quads.filter((q) => q.shapeId === "s1");
  eq(drops.length, 4, "the soffit drops on all four sides");
  ok(drops.every((q) => q.pts.some((p) => p[1] === 8) && q.pts.some((p) => p[1] === 9)), "from 8' up to the 9' ceiling");
  const sc = buildTakeoffScene({ shapes: shapes.map((s) => ({ ...s, sheet_id: "S" })), conditions: conds, sheetId: "S", sheet: CS });
  eq(sc.slabs.map((s) => s.shapeId), ["f1"], "ceilings never become floor slabs (nor stack the floor on them)");
  eq([sc.stats.ceilings, sc.stats.soffits, sc.stats.ceilingAllowances], [3, 1, 1], "stats");
});

// DXF export (dxf.ts) — pins the contract a CAD user leans on: the file is
// structurally R2000 (sections, handles, tables), every takeoff bucket lands
// on its own named layer, rings are CLOSED lwpolylines whose area equals the
// Report's to rounding, the Y axis flips to CAD convention, counts become
// circles, holes ride as their own closed ring, reconciled deducts are not
// double-shipped, metres scale the frame, and nothing is dropped silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetDxf, dxfLayerName, dxfFileName, DXF_STAMP } from "../src/lib/dxf.ts";
import { computeShapeMetrics } from "../src/lib/shapeMetrics.js";

const SHEET = "plan.pdf#1";
const DIMS = { w: 3000, h: 2000 };
const UPP = 0.05;   // 20 px per foot → 150 ft × 100 ft sheet
const CONDS = [
  { id: "c1", finish_tag: "LVT-1" },
  { id: "c2", finish_tag: "CPT 2" },
  { id: "c3", finish_tag: "RB/4\"" },
];

/** Parse a DXF text into [code, value] pairs. */
function pairs(dxf: string): [number, string][] {
  const lines = dxf.split("\n");
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]]);
  return out;
}

/** Entities in the ENTITIES section as {type, layer, pts, closed, r, text}. */
function entities(dxf: string) {
  const p = pairs(dxf);
  const start = p.findIndex(([c, v], i) => c === 2 && v === "ENTITIES" && p[i - 1][1] === "SECTION");
  const ents: { type: string; layer: string; pts: [number, number][]; closed: boolean; r?: number; text?: string; handle?: string }[] = [];
  let cur: (typeof ents)[number] | null = null;
  for (let i = start + 1; i < p.length; i++) {
    const [c, v] = p[i];
    if (c === 0) {
      if (v === "ENDSEC") break;
      cur = { type: v, layer: "", pts: [], closed: false };
      ents.push(cur);
    } else if (cur) {
      if (c === 8) cur.layer = v;
      if (c === 5) cur.handle = v;
      if (c === 10) cur.pts.push([Number(v), 0]);
      if (c === 20) cur.pts[cur.pts.length - 1][1] = Number(v);
      if (c === 70) cur.closed = (Number(v) & 1) === 1;
      if (c === 40) cur.r = Number(v);
      if (c === 1) cur.text = v;
    }
  }
  return ents;
}

function shoelace(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * y1 - x1 * y0; }
  return Math.abs(a) / 2;
}

const room = { id: "s1", sheet_id: SHEET, condition_id: "c1", measure_role: "floor_area", label: "101 LOBBY",
  verts_norm: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]] as [number, number][] };   // 30 ft × 20 ft = 600 SF

test("structure: R2000 header, stamp first, every section, tables with handles, EOF", () => {
  const { dxf, layers, entities: n } = buildSheetDxf({ sheet_id: SHEET, label: "A-101", dims: DIMS, upp: UPP, shapes: [room], conditions: CONDS });
  assert.ok(dxf.startsWith(`999\n${DXF_STAMP}`), "authorship stamp is the first group");
  const p = pairs(dxf);
  const sections = p.filter(([c], i) => c === 2 && p[i - 1][0] === 0 && p[i - 1][1] === "SECTION").map(([, v]) => v);
  assert.deepEqual(sections, ["HEADER", "CLASSES", "TABLES", "BLOCKS", "ENTITIES", "OBJECTS"]);
  assert.equal(p[p.length - 1][1], "EOF");
  assert.ok(p.some(([c, v], i) => c === 9 && v === "$ACADVER" && p[i + 1][1] === "AC1015"));
  assert.ok(p.some(([c, v], i) => c === 9 && v === "$INSUNITS" && p[i + 1][1] === "2"), "feet");
  const tables = p.filter(([c], i) => c === 2 && p[i - 1][1] === "TABLE").map(([, v]) => v);
  assert.deepEqual(tables, ["VPORT", "LTYPE", "LAYER", "STYLE", "VIEW", "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"]);
  // every handle unique, and $HANDSEED above all of them
  const handles = p.filter(([c], i) => (c === 5 && p[i - 1][1] !== "$HANDSEED") || c === 105).map(([, v]) => v);
  assert.equal(new Set(handles).size, handles.length, "handles unique");
  const seed = parseInt(p[p.findIndex(([c, v]) => c === 9 && v === "$HANDSEED") + 1][1], 16);
  for (const hd of handles) assert.ok(parseInt(hd, 16) < seed, `handle ${hd} below $HANDSEED`);
  assert.deepEqual(layers, ["OT-LVT-1", "OT-LABELS"]);
  assert.equal(n, 2);
});

test("a floor ring: closed LWPOLYLINE on OT-<TAG>, Y flipped to bottom-left origin, area = Report SF", () => {
  const { dxf } = buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: UPP, shapes: [room], conditions: CONDS });
  const [ring, label] = entities(dxf);
  assert.equal(ring.type, "LWPOLYLINE");
  assert.equal(ring.layer, "OT-LVT-1");
  assert.equal(ring.closed, true);
  // nx 0.1 → 15 ft; ny 0.1 (near the TOP of the sheet) → 100 − 10 = 90 ft up
  assert.deepEqual(ring.pts[0], [15, 90]);
  assert.deepEqual(ring.pts[2], [45, 70]);
  const sf = computeShapeMetrics(room, DIMS, UPP, CONDS[0]).area_sf;
  assert.equal(sf, 600);
  assert.ok(Math.abs(shoelace(ring.pts) - sf) < 1e-6, "CAD area matches the Report");
  assert.equal(label.type, "TEXT");
  assert.equal(label.layer, "OT-LABELS");
  assert.equal(label.text, "101 LOBBY");
  assert.deepEqual(label.pts[0], [30, 80], "label at the centroid");
});

test("roles map to layers: deduct, hole ring, wall, linear (curved flattens), count → circle", () => {
  const shapes = [
    room,
    { id: "d1", sheet_id: SHEET, condition_id: "c1", measure_role: "deduct", verts_norm: [[0.12, 0.12], [0.14, 0.12], [0.14, 0.14]] as [number, number][] },
    { id: "h1", sheet_id: SHEET, condition_id: "c2", measure_role: "floor_area", verts_norm: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7], [0.5, 0.7]] as [number, number][],
      verts_norm_holes: [[[0.55, 0.55], [0.6, 0.55], [0.6, 0.6], [0.55, 0.6]] as [number, number][]] },
    { id: "w1", sheet_id: SHEET, condition_id: "c3", measure_role: "surface_area", verts_norm: [[0, 0.9], [0.5, 0.9]] as [number, number][], height_ft: 4 },
    { id: "l1", sheet_id: SHEET, condition_id: "c3", measure_role: "linear", curved: true, verts_norm: [[0.1, 0.8], [0.2, 0.85], [0.3, 0.8]] as [number, number][] },
    { id: "k1", sheet_id: SHEET, condition_id: "c2", measure_role: "count", verts_norm: [[0.9, 0.9]] as [number, number][] },
  ];
  const b = buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: UPP, shapes, conditions: CONDS });
  assert.deepEqual(b.layers, ["OT-LVT-1", "OT-LABELS", "OT-LVT-1-DEDUCT", "OT-CPT 2", "OT-CPT 2-HOLE", "OT-RB-4-WALL", "OT-RB-4-LINEAR", "OT-CPT 2-COUNT"]);
  const e = entities(b.dxf);
  const on = (layer: string) => e.filter((x) => x.layer === layer);
  assert.equal(on("OT-LVT-1-DEDUCT")[0].closed, true);
  assert.equal(on("OT-CPT 2-HOLE").length, 1);
  assert.equal(on("OT-CPT 2-HOLE")[0].closed, true);
  assert.equal(on("OT-RB-4-WALL")[0].closed, false);
  assert.deepEqual(on("OT-RB-4-WALL")[0].pts, [[0, 10], [75, 10]]);
  const lin = on("OT-RB-4-LINEAR")[0];
  assert.equal(lin.closed, false);
  assert.ok(lin.pts.length > 3, "curved linear is flattened into more than its 3 control points");
  const k = on("OT-CPT 2-COUNT")[0];
  assert.equal(k.type, "CIRCLE");
  assert.deepEqual(k.pts[0], [135, 10]);
  assert.equal(k.r, 0.5);
  assert.equal(b.shapes, 6);
  assert.deepEqual(b.skipped, []);
});

test("nothing drops silently: reconciled deducts, degenerate rings, other sheets, unknown roles", () => {
  const shapes = [
    room,
    { id: "d2", sheet_id: SHEET, condition_id: "c1", measure_role: "deduct", cuts_shape_id: "s1", verts_norm: [[0.12, 0.12], [0.14, 0.12], [0.14, 0.14]] as [number, number][] },
    { id: "bad", sheet_id: SHEET, condition_id: "c1", measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.2]] as [number, number][] },
    { id: "elsewhere", sheet_id: "plan.pdf#2", condition_id: "c1", measure_role: "floor_area", verts_norm: room.verts_norm },
    { id: "odd", sheet_id: SHEET, condition_id: "c1", measure_role: "mystery", verts_norm: room.verts_norm },
  ];
  const b = buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: UPP, shapes, conditions: CONDS });
  assert.equal(b.shapes, 1);
  assert.deepEqual(b.skipped.map((s) => s.id), ["d2", "bad", "odd"]);
  assert.match(b.skipped[0].reason, /reconciled into s1/);
  assert.equal(entities(b.dxf).filter((e) => e.type === "LWPOLYLINE").length, 1, "the other sheet's ring is not here");
});

test("metres: $INSUNITS 6 and the frame scales by 0.3048", () => {
  const b = buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: UPP, shapes: [room], conditions: CONDS }, { units: "m" });
  assert.ok(b.dxf.includes("$INSUNITS\n70\n6\n"));
  const ring = entities(b.dxf)[0];
  assert.ok(Math.abs(ring.pts[0][0] - 15 * 0.3048) < 1e-9);
  assert.ok(Math.abs(shoelace(ring.pts) - 600 * 0.3048 * 0.3048) < 1e-6);
});

test("refuses without a scale or dims — a CAD file in pixels is worse than none", () => {
  assert.throws(() => buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: 0, shapes: [room], conditions: CONDS }), /no scale/);
  assert.throws(() => buildSheetDxf({ sheet_id: SHEET, dims: { w: 0, h: 0 }, upp: UPP, shapes: [room], conditions: CONDS }), /no image dimensions/);
});

test("an empty sheet still writes a valid file with sheet-sized extents and no takeoff layers", () => {
  const b = buildSheetDxf({ sheet_id: SHEET, dims: DIMS, upp: UPP, shapes: [], conditions: CONDS });
  assert.equal(b.entities, 0);
  assert.deepEqual(b.layers, []);
  assert.equal(b.extents, null);
  assert.ok(b.dxf.includes("$LIMMAX\n10\n150\n20\n100\n"));
});

test("layer names: forbidden characters fold to '-', upper-case, empty → UNTAGGED, capped", () => {
  assert.equal(dxfLayerName("lvt-1"), "OT-LVT-1");
  assert.equal(dxfLayerName('RB/4"'), "OT-RB-4");
  assert.equal(dxfLayerName("a<b>c:d;e?f*g|h,i=j`k"), "OT-A-B-C-D-E-F-G-H-I-J-K");
  assert.equal(dxfLayerName("  "), "OT-UNTAGGED");
  assert.equal(dxfLayerName(undefined, "WALL"), "OT-UNTAGGED-WALL");
  assert.equal(dxfLayerName("x".repeat(80)).length, "OT-".length + 48);
});

test("file names are filesystem-safe and carry the sheet", () => {
  assert.equal(dxfFileName("Mayflower Apts", "A-101"), "Mayflower Apts_A-101.dxf");
  assert.equal(dxfFileName("", "plan.pdf#2"), "takeoff_plan.pdf#2.dxf");
  assert.equal(dxfFileName("a/b:c", ""), "a-b-c.dxf");
});

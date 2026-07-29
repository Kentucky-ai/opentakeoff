// Marked-content layer attribution in extractVectorGeometry + the buildMask
// role short-circuit (#85). Synthetic op lists — the same fake-OPS idiom the
// pure engine was built for; no PDF, no pdf.js. The invariants:
//   - the marked-content stack NESTS: a segment belongs to its nearest
//     enclosing OC group; non-OC marked content pushes but never claims;
//   - only a single stated group attributes (OCG id, or a one-id OCMD) —
//     multi-group OCMDs and expressions stay −1;
//   - unbalanced pops never throw and never mis-attribute;
//   - no marked content ⇒ empty table, all −1, and buildMask WITHOUT roles is
//     byte-identical to the pre-#85 mask (the invisible fallback);
//   - with roles: pattern/annotation/demolition/hidden ink vanishes from the
//     mask, boundary plots hard — the tile-grid discriminator flood proves
//     the lift the heuristics can't reach (4 grid lines < HATCH_MIN_RUN stay
//     hard heuristically; the layer states what they are).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVectorGeometry, buildMask, floodRegion } from "../src/lib/oneclick.ts";
import { classifyLayerName, layerRoleCodes, segRoles, type LayerRole } from "../src/lib/layers.ts";

// a fake OPS table — only what the walk consults
const OPS = {
  save: 1, restore: 2, transform: 3, setLineWidth: 4, setGState: 5,
  constructPath: 10, moveTo: 11, lineTo: 12, curveTo: 13, curveTo2: 14, curveTo3: 15, closePath: 16, rectangle: 17,
  endPath: 20, clip: 21, eoClip: 22, fill: 23, eoFill: 24, stroke: 25,
  beginMarkedContent: 30, beginMarkedContentProps: 31, endMarkedContent: 32,
  paintFormXObjectBegin: 33, paintFormXObjectEnd: 34,
} as const;
const ID = [1, 0, 0, 1, 0, 0];

type Op = [number, unknown[] | null];
const opList = (ops: Op[]) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) });
const oc = (id: string): Op => [OPS.beginMarkedContentProps, ["OC", { type: "OCG", id }]];
const line = (x1: number, y1: number, x2: number, y2: number): Op =>
  [OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]]];
const END: Op = [OPS.endMarkedContent, null];

test("attribution follows the nearest enclosing OC group, through nesting and non-OC marked content", () => {
  const geo = extractVectorGeometry(opList([
    line(0, 0, 5, 0),                        // before any marked content → −1
    oc("wall"),
    line(0, 0, 10, 0),                       // wall
    [OPS.beginMarkedContent, null],          // a plain BMC nests but never claims
    line(0, 1, 10, 1),                       // still wall (nearest enclosing OC)
    oc("hatch"),
    line(0, 2, 10, 2),                       // hatch (inner OC wins)
    END,                                     // pop hatch
    line(0, 3, 10, 3),                       // wall again
    END,                                     // pop the plain BMC
    END,                                     // pop wall
    line(0, 4, 10, 4),                       // −1
    END,                                     // UNBALANCED extra pop — must not throw
    line(0, 5, 10, 5),                       // still −1
  ]), ID, OPS as never);
  assert.deepEqual(geo.layerIds, ["wall", "hatch"]);
  assert.deepEqual([...geo.layerOf!], [-1, 0, 0, 1, 0, -1, -1]);
});

test("only a single stated group attributes: one-id OCMDs do, multi-id OCMDs and null don't", () => {
  const geo = extractVectorGeometry(opList([
    [OPS.beginMarkedContentProps, ["OC", { type: "OCMD", ids: ["only"], policy: "AnyOn", expression: null }]],
    line(0, 0, 1, 0), END,
    [OPS.beginMarkedContentProps, ["OC", { type: "OCMD", ids: ["a", "b"], policy: "AnyOn", expression: null }]],
    line(0, 1, 1, 1), END,
    [OPS.beginMarkedContentProps, ["OC", null]],   // malformed OC props (worker warns, emits null)
    line(0, 2, 1, 2), END,
  ]), ID, OPS as never);
  assert.deepEqual(geo.layerIds, ["only"]);
  assert.deepEqual([...geo.layerOf!], [0, -1, -1]);
});

test("no marked content: empty table, all −1 — and the roleless mask is byte-identical (the invisible fallback)", () => {
  const ops: Op[] = [line(0, 0, 50, 0), line(0, 10, 50, 10), line(20, 0, 20, 10)];
  const geo = extractVectorGeometry(opList(ops), ID, OPS as never);
  assert.deepEqual(geo.layerIds, []);
  assert.ok(geo.layerOf!.every((v) => v === -1));
  const a = buildMask(geo.segs, 60, 20, 3000, geo.meta);
  const b = buildMask(geo.segs, 60, 20, 3000, geo.meta, null);
  assert.deepEqual(Buffer.from(a.mask), Buffer.from(b.mask), "null roles = the pre-#85 mask, bit for bit");
});

// ── the discriminator: the fixture scene, flooded three ways ────────────────
// A 300×300 room; a 3×3 tile grid inside (FOUR lines — far under
// HATCH_MIN_RUN, so heuristics keep them hard); an annotation leader crossing
// the room; a hidden demolition wall bisecting it.
function fixtureScene() {
  return extractVectorGeometry(opList([
    oc("wall"), [OPS.constructPath, [[OPS.rectangle], [100, 100, 300, 300]]], END,
    oc("patt"),
    line(200, 100, 200, 400), line(300, 100, 300, 400),
    line(100, 200, 400, 200), line(100, 300, 400, 300),
    END,
    oc("anno"), line(110, 110, 390, 390), END,
    oc("demo"), line(100, 250, 400, 250), END,
  ]), ID, OPS as never);
}
const NAMES: Record<string, string> = { wall: "A-WALL-FULL", patt: "A-FLOR-PATT", anno: "A-ANNO-TEXT", demo: "A-WALL-DEMO" };
const infoFor = (visibleDemo: boolean, demoRole?: LayerRole) => {
  const m = new Map<string, { role: LayerRole; visible: boolean }>();
  for (const [id, name] of Object.entries(NAMES)) {
    const { role } = classifyLayerName(name);
    m.set(id, { role: id === "demo" && demoRole ? demoRole : role, visible: id === "demo" ? visibleDemo : true });
  }
  return m;
};

test("stated layers unlock what the pitch heuristics cannot: the tile-grid room floods WHOLE", () => {
  const geo = fixtureScene();
  const seed: [number, number] = [150, 150];   // inside one tile cell
  // heuristic-only mask: 4 grid lines are far below HATCH_MIN_RUN — they stay
  // hard and the flood traps inside one of nine cells
  const naive = buildMask(geo.segs, 1200, 1200, 3000, geo.meta);
  const fNaive = floodRegion(naive, seed[0], seed[1]);
  assert.equal(fNaive.status, "ok");
  // layered mask: the file SAYS patt is pattern, anno is annotation, demo is
  // hidden — all excluded; wall says boundary — hard
  const roles = segRoles(geo.layerOf, layerRoleCodes(geo.layerIds!, infoFor(false)))!;
  const layered = buildMask(geo.segs, 1200, 1200, 3000, geo.meta, roles);
  const fLayered = floodRegion(layered, seed[0], seed[1]);
  assert.equal(fLayered.status, "ok");
  const nCell = (fNaive as { count: number }).count, nRoom = (fLayered as { count: number }).count;
  assert.ok(nRoom > 5 * nCell, `stated layers must free the flood: cell=${nCell}, room=${nRoom}`);
  assert.ok(nRoom > 280 * 280, `the whole 300×300 room, not a slice: ${nRoom}`);
});

test("an INCLUDED demolition wall splits the room — visibility and overrides both bite", () => {
  const geo = fixtureScene();
  const roles = segRoles(geo.layerOf, layerRoleCodes(geo.layerIds!, infoFor(true, "boundary")))!;
  const mask = buildMask(geo.segs, 1200, 1200, 3000, geo.meta, roles);
  const f = floodRegion(mask, 150, 150);       // seed above the y=250 demo wall
  assert.equal(f.status, "ok");
  const n = (f as { count: number }).count;
  assert.ok(n > 280 * 130 && n < 300 * 170, `half the room, bounded by the demo wall: ${n}`);
});

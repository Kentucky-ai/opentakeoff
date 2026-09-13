// Arcs over MCP (0.9.87): arc_through bends a trace the way the canvas's Curve
// mode does — the unique circle through start, bow and far end, baked to
// vertices on commit, origin.curved stamped. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";
import { flattenArcRing } from "../../web/src/lib/arc.js";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function scaled() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 });   // 1 ft per px: quantities read as px
  return s;
}

// A half-disc of radius 100 px: base from (100,300) to (300,300), bow at the
// top of the circle (200,200). Exact area πr²/2 = 15707.96, exact perimeter
// = diameter + half-circumference = 200 + 314.16 = 514.16.
const HALF = { verts: [[100, 300], [200, 200], [300, 300]] as [number, number][], arc: [1] };

test("measure_polygon: a bow point makes a true arc — area and perimeter of the half-disc", async () => {
  const s = await scaled();
  const r = s.measurePolygon(KEY, HALF.verts, { role: "floor_area", condition: "CPT-1", arc_through: HALF.arc });
  assert.equal(r.arcs, 1);
  assert.ok(r.nverts > 20, `baked to ${r.nverts} vertices`);
  assert.ok(Math.abs(r.area_sf - Math.PI * 100 * 100 / 2) / (Math.PI * 100 * 100 / 2) < 0.002, `area ${r.area_sf}`);
  assert.ok(Math.abs(r.perimeter_lf - (200 + Math.PI * 100)) / (200 + Math.PI * 100) < 0.002, `perimeter ${r.perimeter_lf}`);
  const shape = s.exportPayload().shapes.find((x: any) => x.id === r.shape_id)!;
  assert.equal(shape.verts_norm.length, r.nverts, "the committed shape IS the baked arc");
  assert.equal(shape.origin!.curved, true, "the canvas's stamp");
  assert.equal(shape.origin!.actor, "agent");
  assert.equal(shape.origin!.reviewed, false);
  assert.equal((shape as any).curved, undefined, "never the legacy spline flag on the shape");
});

test("measure_polygon: the baked ring is the canvas's flattenArcRing, vertex for vertex", async () => {
  const s = await scaled();
  const r = s.measurePolygon(KEY, HALF.verts, { role: "floor_area", condition: "CPT-1", arc_through: HALF.arc });
  const shape = s.exportPayload().shapes.find((x: any) => x.id === r.shape_id)!;
  const { widthPx, heightPx } = (s as any).sheet(KEY);
  const expect = flattenArcRing(HALF.verts, HALF.arc, true);
  assert.equal(shape.verts_norm.length, expect.length);
  for (let i = 0; i < expect.length; i++) {
    assert.ok(Math.abs(shape.verts_norm[i][0] * widthPx - expect[i][0]) < 1e-6);
    assert.ok(Math.abs(shape.verts_norm[i][1] * heightPx - expect[i][1]) < 1e-6);
  }
});

test("measure_polygon: no arc_through is the plain polygon — identical to before", async () => {
  const s = await scaled();
  const a = s.measurePolygon(KEY, [[100, 100], [300, 100], [300, 300], [100, 300]], { role: "floor_area" });
  const b = s.measurePolygon(KEY, [[100, 100], [300, 100], [300, 300], [100, 300]], { role: "floor_area", arc_through: [] });
  assert.deepEqual(a, b);
  assert.equal(a.nverts, 4);
  assert.equal("arcs" in a, false);
});

test("measure_line: a bowed run measures along the arc, not the chord", async () => {
  const s = await scaled();
  const r = s.measureLine(KEY, [[100, 300], [200, 200], [300, 300]], { condition: "RB-1", arc_through: [1] });
  assert.equal(r.arcs, 1);
  assert.ok(Math.abs(r.length_lf - Math.PI * 100) / (Math.PI * 100) < 0.002, `arc length ${r.length_lf} (chords would be 282.8)`);
  const shape = s.exportPayload().shapes.find((x: any) => x.id === r.shape_id)!;
  assert.equal(shape.origin!.curved, true);
  assert.equal(shape.measure_role, "linear");
});

test("measure_surface: a radius wall's tile is arc LF × height, origin.curved stamped", async () => {
  const s = await scaled();
  const r = s.measureSurface(KEY, [[100, 300], [200, 200], [300, 300]], { condition: "CT-W1", height_ft: 8, arc_through: [1] });
  assert.equal(r.arcs, 1);
  assert.ok(Math.abs(r.length_lf - Math.PI * 100) < 1);
  assert.ok(Math.abs(r.area_sf - Math.PI * 100 * 8) < 8);
  const shape = s.exportPayload().shapes.find((x: any) => x.id === r.shape_id)!;
  assert.equal(shape.origin!.curved, true);
  assert.equal(shape.height_ft, 8);
});

test("refusals: an index off the trace, a bow at an open run's end, two bows in a row — nothing minted", async () => {
  const s = await scaled();
  const before = s.exportPayload().shapes.length;
  assert.throws(() => s.measurePolygon(KEY, HALF.verts, { role: "floor_area", condition: "CPT-1", arc_through: [3] }), /off the trace/);
  assert.throws(() => s.measureLine(KEY, [[0, 0], [100, 50], [200, 0]], { condition: "RB-1", arc_through: [0] }), /END of the open run/);
  assert.throws(() => s.measureSurface(KEY, [[0, 0], [100, 50], [200, 0]], { condition: "CT-W1", height_ft: 8, arc_through: [2] }), /END of the open run/);
  assert.throws(() => s.measurePolygon(KEY, [[0, 0], [100, 50], [200, 0], [200, 200]], { role: "floor_area", condition: "CPT-1", arc_through: [1, 2] }), /adjacent/);
  assert.equal(s.exportPayload().shapes.length, before, "a refused arc mints nothing");
  // the surface refusal happened BEFORE the height gate could write the condition's H knob
  assert.equal(s.exportPayload().conditions.find((c: any) => c.finish_tag === "CT-W1"), undefined);
});

test("a closed ring may bow at index 0 and at the last index — the wrap is a real corner triple", async () => {
  const s = await scaled();
  // square with two opposite bowed sides: bows at 0 and 2 (corners at 1 and 3)
  const verts: [number, number][] = [[200, 100], [300, 200], [200, 300], [100, 200]];
  const r = s.measurePolygon(KEY, verts, { role: "floor_area", arc_through: [0, 2] });
  assert.equal(r.arcs, 2);
  assert.ok(r.nverts > 8);
});

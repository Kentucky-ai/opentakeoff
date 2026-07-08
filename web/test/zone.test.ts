// Zone check: center-point classification + Report-rule rollup on the filtered set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapesInZone, shapeCenter } from "../src/lib/zone.js";
import { conditionTotals } from "../src/lib/totals.js";

const zone = { key: "plan.pdf", pts: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]] };
const sq = (id: string, cond: string, cx: number, cy: number, sf: number, sheet = "plan.pdf") => ({
  id, sheet_id: sheet, condition_id: cond, measure_role: "floor_area",
  verts_norm: [[cx - 0.01, cy - 0.01], [cx + 0.01, cy - 0.01], [cx + 0.01, cy + 0.01], [cx - 0.01, cy + 0.01]],
  computed: { area_sf: sf },
});

test("shapesInZone counts by center, same sheet only", () => {
  const shapes = [
    sq("in1", "c1", 0.2, 0.2, 100),
    sq("in2", "c2", 0.4, 0.4, 50),
    sq("out", "c1", 0.8, 0.8, 999),
    sq("other-sheet", "c1", 0.2, 0.2, 999, "other.pdf"),
  ];
  const hit = shapesInZone(shapes, zone);
  assert.deepEqual(hit.map((s: any) => s.id).sort(), ["in1", "in2"]);
  assert.equal(shapesInZone(shapes, null).length, 0);
  assert.equal(shapeCenter({ verts_norm: [] }), null);
});

test("zone rollup uses the Report's own rules incl. materials", () => {
  const conditions = [
    { id: "c1", finish_tag: "CT-1", multiplier: 1, waste_pct: 0,
      materials: [{ name: "Thinset", per: 50, basis: "area", unit: "bag" }] },
    { id: "c2", finish_tag: "LVT-1", multiplier: 1, waste_pct: 0, materials: [] },
  ];
  const rows = conditionTotals(conditions, shapesInZone([
    sq("in1", "c1", 0.2, 0.2, 100), sq("in2", "c2", 0.4, 0.4, 50), sq("out", "c1", 0.8, 0.8, 999),
  ], zone)).filter((r: any) => r.shape_count > 0);
  const ct = rows.find((r: any) => r.finish_tag === "CT-1");
  assert.equal(ct.total_sf, 100);            // the out-of-zone 999 SF never leaks in
  assert.equal(ct.materials[0].qty, 2);      // ceil(100 / 50)
  assert.equal(rows.find((r: any) => r.finish_tag === "LVT-1").total_sf, 50);
});

// Parity: the server mints conditions, stamps schemas and snaps geometry with
// the SAME values the browser uses, because it imports the same module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAKEOFF_SCHEMA, REPORT_SCHEMA, PALETTE, HATCH_IDS, nextHatchId, nextPaletteColor } from "../../web/src/lib/takeoffConstants.ts";
import { Session, ANN_SCHEMA } from "../src/session.ts";
import { exportReportOutput } from "../src/outputs.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

test("no hand copy of the shared values remains in mcp/src", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of ["session.ts", "outputs.ts", "safewrite.ts", "importing.ts", "tools.ts", "marked.ts", "view.ts", "pdf.ts"]) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.equal(/const (PALETTE|HATCH_IDS|SNAP_CELL|SNAP_TOL|RENDER_SCALE)\s*=/.test(src), false, `${f} declares a mirrored constant`);
    assert.equal(/=\s*"opentakeoff\.(takeoff_canvas|report)\.v1"/.test(src), false, `${f} re-declares a schema id`);
  }
});

test("schema ids come from the shared module", () => {
  assert.equal(ANN_SCHEMA, TAKEOFF_SCHEMA);
  assert.equal(exportReportOutput.schema.value, REPORT_SCHEMA);
});

test("a minted condition carries the shared palette and hatch rotation", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  const sheet = KEY;
  s.setScale(sheet, { upp: 0.5 });
  const tags = ["CPT-1", "VCT-1", "PT-1"];
  for (const t of tags) s.measurePolygon(sheet, [[100, 100], [300, 100], [300, 300], [100, 300]], { condition: t, role: "floor_area" });
  const p = s.exportPayload();
  assert.equal(p.schema, TAKEOFF_SCHEMA);
  tags.forEach((tag, i) => {
    const c = p.conditions.find((x: any) => x.finish_tag === tag);
    assert.ok(c, tag);
    assert.equal(c.color, nextPaletteColor(i));
    assert.equal(c.fill, PALETTE[i]);
    assert.equal(c.hatch, nextHatchId(i));
    assert.ok(HATCH_IDS.includes(c.hatch));
    assert.notEqual(c.hatch, "solid");
  });
});

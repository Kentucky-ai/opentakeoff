// Mixed-scale honesty (#153) — the pure comparison plus the live wiring: an
// enlarged plan's own scale note inside a measured region must surface a
// warning; agreement, absence, and the unscaled path must stay silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mixedScaleWarning, expandForScaleNotes, UPP_TOLERANCE } from "../src/scalewarn.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

// identity-scale viewport: item transform [1,0,0,1,x,y] → position (x, y)
const VP = { width: 2000, height: 1500, transform: [1, 0, 0, 1, 0, 0] };
const item = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 5, height: 10 });
// upp at render scale 2.0: 1/8" = 1'-0" → 18 px/ft; 1/2" → 72 px/ft
const UPP_EIGHTH = 1 / 18;

test("mixedScaleWarning: a disagreeing note warns; agreement, absence, and no-scale stay silent", () => {
  const disagree = { items: [item('SCALE: 1/2" = 1\'-0"', 300, 400)] };
  const w = mixedScaleWarning(disagree, VP, UPP_EIGHTH, '1/8" = 1\'-0"');
  assert.ok(w, "a 1/2\" note against a 1/8\" sheet warns");
  assert.match(w!, /1\/2/);
  assert.match(w!, /enlarged plan/);

  const agree = { items: [item('SCALE: 1/8" = 1\'-0"', 300, 400)] };
  assert.equal(mixedScaleWarning(agree, VP, UPP_EIGHTH, '1/8" = 1\'-0"'), undefined, "the sheet's own note is not a mixed scale");

  assert.equal(mixedScaleWarning({ items: [] }, VP, UPP_EIGHTH, undefined), undefined, "no note, no warning");
  assert.equal(mixedScaleWarning(disagree, VP, null, undefined), undefined, "the unscaled path has its own warning");

  // within tolerance = label-formatting noise, not a mixed scale
  const near = mixedScaleWarning(agree, VP, UPP_EIGHTH * (1 + UPP_TOLERANCE * 0.9), undefined);
  assert.equal(near, undefined);
});

test("expandForScaleNotes: reaches further BELOW the bbox than out (notes sit under their viewport)", () => {
  const r = expandForScaleNotes({ x0: 100, y0: 100, x1: 300, y1: 200 });
  assert.ok(r.x0 < 100 && r.x1 > 300 && r.y0 < 100, "expands on every side");
  assert.ok(r.y1 - 200 > r.x1 - 300, "below-reach beats side-reach");
  assert.ok(r.y1 - 200 > 100 - r.y0, "reaches further below than above");
});

test("live wiring: a normal room on the single-scale sample plan carries no mixed-scale warning", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  const r: any = await s.oneClick(KEY, 600, 1084, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  assert.ok(r.area_sf > 0);
  assert.equal(r.warning, undefined, "single-scale sheet, room region — silent");
  const m: any = s.measurePolygon(KEY, [[100, 100], [200, 100], [200, 200], [100, 200]], { role: "floor_area" });
  assert.equal(m.warning, undefined);
});

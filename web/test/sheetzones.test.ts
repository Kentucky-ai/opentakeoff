// Sheet zoning (Stage 0) — annotation territory is found from the sheet's own
// text layout, before any wall reasoning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationZones, inZones, isTextDecoration, spanGrid, type TextSpanBox } from "../src/lib/sheetzones.ts";

const span = (str: string, x0: number, y0: number, w = 60, h = 12): TextSpanBox => ({ str, x0, y0, x1: x0 + w, y1: y0 + h });

test("margin: the title-block rule claims everything right of it", () => {
  // a near-full-height vertical at x=940 on a 1000×800 sheet = title block rule
  const segs = [940, 20, 940, 780];
  const zones = annotationZones([], segs, 1000, 800);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].kind, "margin");
  assert.ok(inZones(zones, 970, 400), "inside the title block");
  assert.ok(!inZones(zones, 900, 400), "plan side of the rule stays");
});

test("a schedule column zones out; a lone room label does not", () => {
  const spans: TextSpanBox[] = [
    // six left-aligned rows at uniform pitch — a schedule's mark column
    ...Array.from({ length: 6 }, (_, i) => span(`TA-${i}`, 100, 100 + i * 20)),
    span("BEDROOM 2", 600, 400),                      // a plan room label
  ];
  const zones = annotationZones(spans, [], 1000, 800);
  assert.equal(zones.length, 1, "one table zone");
  assert.equal(zones[0].kind, "table");
  assert.ok(inZones(zones, 120, 150), "the column body is zoned");
  assert.ok(!inZones(zones, 600, 405), "the room label is not");
});

test("scattered plan labels never form a zone", () => {
  const spans = [
    span("KITCHEN", 300, 120), span("BATH 1", 700, 300), span("CLOSET", 150, 600),
    span("LIVING ROOM", 500, 500), span("LAUNDRY", 800, 150),
  ];
  assert.equal(annotationZones(spans, [], 1000, 800).length, 0);
});

test("a keyword header seeds a zone and merges into the rows under it", () => {
  const spans = [
    span("Toilet Accessory Schedule", 90, 76, 180),
    ...Array.from({ length: 5 }, (_, i) => span(`TA-${i}`, 100, 100 + i * 20)),
  ];
  const zones = annotationZones(spans, [], 1000, 800);
  assert.equal(zones.length, 1, "header and column merge into one zone");
  assert.ok(inZones(zones, 200, 80), "the header row is inside");
});

test("a zone may never swallow the plan (area cap)", () => {
  // a pathological run spanning most of the sheet must be refused
  const spans = Array.from({ length: 40 }, (_, i) => span(`X${i}`, 100, 20 + i * 19.5, 850));
  const zones = annotationZones(spans, [], 1000, 800);
  assert.equal(zones.filter((z) => z.kind === "table").length, 0, "over-cap zone dropped");
});

test("text decoration: an underline dies, a wall passing under text survives", () => {
  const spans = [span("BEDROOM 2", 200, 300, 80)];
  const g = spanGrid(spans);
  assert.ok(isTextDecoration(spans, g, 64, 200, 314, 282, 314), "the underline is decoration");
  assert.ok(!isTextDecoration(spans, g, 64, 100, 314, 500, 314), "the long wall is not");
  assert.ok(!isTextDecoration(spans, g, 64, 200, 600, 282, 600), "ink far from text is not");
});

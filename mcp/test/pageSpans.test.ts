// The canvas's spans builder (web/src/lib/pageSpans.ts) against the MCP's own
// text layer (mcp/src/pdf.ts textSpans / positionedText). Import from schedule
// and the agent's read_schedule read a marquee through the same finish reader
// the sheet graph indexes with (plus rules only a drawn box gets: codes with a
// word after them, NOT USED rows, four- and five-letter codes), so they must
// hand it the same spans the MCP hands buildSheetGraph — every box and every
// baseline origin, exactly, not within a tolerance. The builder is a pure
// copy of rawSpans' math with the render scale as a parameter (the canvas
// renders at its own scale); at RENDER_SCALE the two must agree to the last
// decimal.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openPdf, textSpans, positionedText, type PageHandle } from "../src/pdf.ts";
import { pageSpans, spansInRect, graphSpans } from "../../web/src/lib/pageSpans.ts";
import { RENDER_SCALE } from "../../web/src/lib/takeoffConstants.ts";

const DEMO = fileURLToPath(new URL("../../web/public/demo/sample-finish-plan.pdf", import.meta.url));

async function demoPage(n: number): Promise<PageHandle> {
  const doc = await openPdf(DEMO);
  return doc.page(n);
}

/** Every span, field for field: the MCP box → the graph's {x, y, w, h, rot}. */
function assertParity(ph: PageHandle) {
  const got = pageSpans(ph.textContent.items, ph.viewport.transform, RENDER_SCALE);
  const boxes = textSpans(ph);
  const origins = positionedText(ph);
  assert.equal(got.length, boxes.length, "one span per joined MCP span");
  assert.equal(got.length, origins.length);
  got.forEach((s, i) => {
    const t = boxes[i];
    assert.deepEqual(
      { str: s.str, x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot },
      { str: t.str, x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, rot: t.rot },
      `span ${i} "${t.str}"`,
    );
    assert.deepEqual({ str: s.str, x: s.ox, y: s.oy }, origins[i], `origin ${i} "${t.str}"`);
    assert.equal("rot" in s, "rot" in t, `span ${i}: rot only when nonzero`);
  });
  return got;
}

test("demo p2: the builder equals the MCP text layer, every span, exactly", async () => {
  const got = assertParity(await demoPage(2));
  assert.ok(got.length > 500, "the whole sheet's text");
  // the split finish tags come back joined, as the MCP reads them
  assert.ok(got.some((s) => s.str === "VCT-1"));
});

test("rotated runs and missing heights: same hull, same fallback as rawSpans", () => {
  // a synthetic page: a plain run, a quarter-turn run, a run with no height
  // (the transform's column norm stands in), and a whitespace run (skipped)
  const ph = {
    viewport: { width: 400, height: 400, transform: [2, 0, 0, -2, 0, 800] },
    textContent: {
      items: [
        { str: "CPT-1", transform: [10, 0, 0, 10, 20, 300], width: 30, height: 10 },
        { str: "FLOORING", transform: [0, 10, -10, 0, 120, 200], width: 48, height: 10 },
        { str: "NOTE", transform: [9, 0, 0, 9, 50, 250], width: 20 },
        { str: "  ", transform: [10, 0, 0, 10, 0, 0], width: 5, height: 10 },
      ],
    },
  } as unknown as PageHandle;
  const got = assertParity(ph);
  assert.equal(got.length, 3);
  assert.equal(got[1].rot, 270);
});

test("the render scale is a parameter: the canvas's own scale moves every box", async () => {
  const ph = await demoPage(2);
  const at2 = pageSpans(ph.textContent.items, ph.viewport.transform, RENDER_SCALE);
  // a viewport at 3/2 the scale: the transform scales, and so must widths
  const t = ph.viewport.transform.map((v) => v * 1.5);
  const at3 = pageSpans(ph.textContent.items, t, RENDER_SCALE * 1.5);
  const a = at2.find((s) => s.str === "VCT-1")!, b = at3.find((s) => s.str === "VCT-1")!;
  assert.ok(Math.abs(b.w - a.w * 1.5) < 0.2 && Math.abs(b.ox - a.ox * 1.5) < 0.2, "width and origin scale together");
});

test("spansInRect crops by the joined span's baseline origin, inclusive, any corner order", () => {
  const sp = (str: string, ox: number, oy: number) => ({ str, x: ox, y: oy - 10, w: 30, h: 10, ox, oy });
  const spans = [sp("IN", 10, 20), sp("EDGE", 100, 50), sp("OUT", 101, 20), sp("TALL", 50, 51)];
  const keep = (r: { x0: number; y0: number; x1: number; y1: number }) => spansInRect(spans, r).map((s) => s.str);
  assert.deepEqual(keep({ x0: 0, y0: 0, x1: 100, y1: 50 }), ["IN", "EDGE"]);
  assert.deepEqual(keep({ x0: 100, y0: 50, x1: 0, y1: 0 }), ["IN", "EDGE"], "a box dragged up-left crops the same");
  // the box does not have to hold the whole run: a span whose top pokes above
  // the marquee still belongs to it when its baseline origin is inside
  assert.deepEqual(keep({ x0: 0, y0: 15, x1: 100, y1: 25 }), ["IN"]);
});

test("graphSpans drops the origins and keeps rot only when present", () => {
  const out = graphSpans([
    { str: "A", x: 1, y: 2, w: 3, h: 4, ox: 1, oy: 6 },
    { str: "B", x: 1, y: 2, w: 3, h: 4, rot: 90, ox: 5, oy: 2 },
  ]);
  assert.deepEqual(out, [{ str: "A", x: 1, y: 2, w: 3, h: 4 }, { str: "B", x: 1, y: 2, w: 3, h: 4, rot: 90 }]);
});

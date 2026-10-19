// The classifiers stage — netroom's seam over the four ink classifiers, and
// the hatch row-mask query optimization.
//
// classifySoftStage must reproduce build()'s composition exactly: the four
// classifiers called with the same arguments and guards, the PRE-merge hatch
// snapshot returned as `hatch` (it feeds finishGrid/hatchFlags), and the
// merged plane in a FRESH `soft` array (an alias would rewrite finishGrid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySoftStage } from "../src/lib/netroom.js";

// 10 px per foot keeps every threshold whole.
const FT = 10;

interface Fixture {
  segs: number[];
  meta: Uint8Array;
  subpaths?: Array<{ i0: number; i1: number; x0: number; y0: number; x1: number; y1: number; closed: boolean; flags: number; fillLum: number }>;
  texts?: Array<{ x: number; y: number; w: number; h: number }>;
}

/** One synthetic sheet holding exactly the geometry each classifier needs:
 *
 *   idx 0–4   a 5-line vertical hatch field at 4 px pitch (cap 13.3 px): the
 *             interior rows 1–3 have ±p and ±2p same-width neighbours;
 *   idx 5     a hairline run with a heavier parallel partner idx 6, 10 px off,
 *             running alongside for its whole 60 px (> ANNOT_MIN_LEN 40 px);
 *   idx 7–12  six sub-wall flecks in one 2 ft cell (FLECK_FIELD_MIN === 6);
 *   idx 13–16 a 20×20 px closed box with 14×14 px of text filling it
 *             (area 400 ≤ TAGBOX_MAX_SF·ftPx² = 600; text area 196 ≥ 100).
 *
 * Every contributor owns disjoint segment indices, so the exact union is
 * observable rather than incidental. */
function fixture(opts: { subpaths?: boolean; texts?: boolean } = {}): Fixture {
  const segs: number[] = [];
  const meta: number[] = [];
  const subpaths: NonNullable<Fixture["subpaths"]> = [];
  const push = (x1: number, y1: number, x2: number, y2: number, mt: number): number => {
    const i = segs.length >> 2;
    segs.push(x1, y1, x2, y2);
    meta.push(mt);
    return i;
  };
  for (let k = 0; k < 5; k++) push(100 + k * 4, 100, 100 + k * 4, 500, 1 << 4);
  push(0, 200, 60, 200, 1 << 4);
  push(0, 210, 60, 210, 2 << 4);
  for (let k = 0; k < 6; k++) {
    const i = push(300 + k * 3, 300, 301 + k * 3, 300, 0);
    subpaths.push({ i0: i, i1: i + 1, x0: 300 + k * 3, y0: 300, x1: 301 + k * 3, y1: 300, closed: true, flags: 0, fillLum: 0 });
  }
  const box0 = push(500, 500, 520, 500, 1 << 4);
  push(520, 500, 520, 520, 1 << 4);
  push(520, 520, 500, 520, 1 << 4);
  push(500, 520, 500, 500, 1 << 4);
  subpaths.push({ i0: box0, i1: box0 + 4, x0: 500, y0: 500, x1: 520, y1: 520, closed: true, flags: 0, fillLum: 0 });
  return {
    segs,
    meta: Uint8Array.from(meta),
    subpaths: opts.subpaths === false ? undefined : subpaths,
    texts: opts.texts === false ? undefined : [{ x: 505, y: 525, w: 14, h: 14 }],
  };
}

const softIdx = (u: Uint8Array | number[] | null): number[] | null =>
  u ? Array.from(u as ArrayLike<number>).flatMap((v, i) => (v ? [i] : [])) : null;

test("classifySoftStage: four contributors soften their own segments; union exact, hatch pre-merge", () => {
  const f = fixture();
  const out = classifySoftStage({ segs: f.segs, meta: f.meta, subpaths: f.subpaths, texts: f.texts, ftPx: FT });
  assert.deepEqual(softIdx(out.hatch), [1, 2, 3], "hatch softens the interior lattice rows only");
  assert.deepEqual(softIdx(out.annot), [5], "the hairline of the heavyweight pair is annotation");
  assert.deepEqual(softIdx(out.fleck), [7, 8, 9, 10, 11, 12], "the fleck field softens the whole figure set");
  assert.deepEqual(softIdx(out.tagbox), [13, 14, 15, 16], "the text-filled box is a tag box");
  assert.deepEqual(softIdx(out.soft), [1, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "the union is exactly the four contributions");
  // Pre-merge hatch: it must not carry the other classifiers' votes, and it
  // must not be the same array as `soft` (finishGrid/hatchFlags read it).
  assert.notStrictEqual(out.hatch, out.soft);
  assert.notDeepEqual(out.hatch, out.soft);
  out.hatch[1] = 0;
  assert.equal(out.soft[1], 1, "mutating hatch must not reach the merged plane");
});

test("classifySoftStage: no subpaths/texts — fleck and tagbox are null", () => {
  const f = fixture({ subpaths: false, texts: false });
  const out = classifySoftStage({ segs: f.segs, meta: f.meta, subpaths: f.subpaths, texts: f.texts, ftPx: FT });
  assert.equal(out.fleck, null);
  assert.equal(out.tagbox, null);
  assert.deepEqual(softIdx(out.soft), [1, 2, 3, 5], "hatch and annotation still run");
});

test("classifySoftStage: subpaths absent, texts present — tagbox is null, not a zero array", () => {
  const f = fixture({ subpaths: false });
  assert.ok(f.texts?.length);
  const out = classifySoftStage({ segs: f.segs, meta: f.meta, subpaths: f.subpaths, texts: f.texts, ftPx: FT });
  assert.equal(out.fleck, null);
  assert.equal(out.tagbox, null);
});

test("classifyHatchSegs: a query window just above half a cell still softens", () => {
  // Five 0.8 px-long parallel strokes at 2 px pitch. Their projected span is
  // 0.8 (half a cell < 0.8 < 1), so the short-query skip must NOT fire: the
  // middle rows are a valid lattice and soften. Widening the skip to
  // `t1 - t0 < 1` (a plausible "round up" mutant) leaves every row hard.
  const segs: number[] = [];
  const meta: number[] = [];
  for (let k = 0; k < 5; k++) {
    segs.push(0, k * 2, 0.8, k * 2);
    meta.push(1 << 4);
  }
  const soft = classifySoftStage({ segs, meta: Uint8Array.from(meta), subpaths: undefined, texts: undefined, ftPx: FT }).hatch;
  assert.deepEqual(softIdx(soft), [1, 2, 3], "interior 0.8 px-span rows soften");
});

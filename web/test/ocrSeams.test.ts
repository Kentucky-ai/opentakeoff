// Tiled OCR reads and their seams (#471). A page too big for one raster is
// read as overlapping tiles; lines cut by a tile's edge are read again from a
// patch across the seam. planTiles, the keep rule and the patch join are pure,
// so they are pinned here: the tile maths against the real render factor, the
// keep rule case by case, and the whole pipeline against ground truth through
// a fake recognizer that behaves like the engine at a raster edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignLines, createSeamRun, inCore, joinPatches, nearMargin, planTiles,
  type Rect, type SeamJob, type SeamLine, type SeamProgress, type TilePlan,
} from "../src/lib/ocr/seams.ts";
import { ocrRenderFactor, OCR_TARGET_DPI } from "../src/lib/ocr/rasterize.ts";
import { cropBoxToWord, OCR_DETECTION_PADDING, renderDims, unpadCropBox, type CropBox } from "../src/lib/ocr/raster.ts";
import { SCAN_MAX_DIM } from "../src/lib/scheduleScan.ts";
import type { OcrWord } from "../src/lib/ocr/types.ts";

const IN = 72; // PDF points per inch
const RS = [1, 2, 1.37];
const PAGES: [number, number][] = [[36, 24], [42, 30], [48, 36], [8.5, 11]];
const pageRect = (wIn: number, hIn: number, rs: number): Rect => ({ x0: 0, y0: 0, x1: wIn * IN * rs, y1: hIn * IN * rs });
// rasterizeRegion's own side lengths
const side = (a: number, b: number) => Math.max(1, Math.abs(b - a));
const factorOf = (rs: number, r: Rect) => ocrRenderFactor(rs, side(r.x0, r.x1), side(r.y0, r.y1));
const dimsOf = (r: Rect, zoom: number) => renderDims({ rect: { x0: r.x0, y0: r.y0, x1: r.x0 + side(r.x0, r.x1), y1: r.y0 + side(r.y0, r.y1) }, zoom });

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── planTiles ────────────────────────────────────────────────────────────────

test("every tile renders at exactly the target DPI and inside the scan cap", () => {
  for (const rs of RS) for (const [w, h] of PAGES) {
    const rect = pageRect(w, h, rs);
    const plan = planTiles(rect, rs);
    const target = OCR_TARGET_DPI / (IN * rs);
    assert.equal(plan.zoom, target, `${w}×${h} rs ${rs}`);
    assert.equal(plan.overlap, IN * rs);
    assert.equal(plan.dpi, OCR_TARGET_DPI, "the DPI rasterizeRegion must be given");
    for (const t of plan.tiles) {
      assert.equal(factorOf(rs, t.render), target, `${w}×${h} rs ${rs} tile ${t.index}: factor`);
      const d = dimsOf(t.render, plan.zoom);
      assert.ok(d.width <= SCAN_MAX_DIM && d.height <= SCAN_MAX_DIM, `${w}×${h} rs ${rs} tile ${t.index}: ${d.width}×${d.height}`);
      // render = core ± overlap, clipped to the rect
      assert.deepEqual(t.render, {
        x0: Math.max(rect.x0, t.core.x0 - plan.overlap), y0: Math.max(rect.y0, t.core.y0 - plan.overlap),
        x1: Math.min(rect.x1, t.core.x1 + plan.overlap), y1: Math.min(rect.y1, t.core.y1 + plan.overlap),
      });
    }
  }
});

test("tile counts: balanced cores no bigger than the render cap allows", () => {
  // At 216 DPI the cap is 4096 px ≈ 18.96 in a side; less 1 in of overlap on
  // each side leaves ≈ 16.9 in of core.
  const counts = (w: number, h: number, rs: number) => {
    const p = planTiles(pageRect(w, h, rs), rs);
    return [new Set(p.tiles.map(t => t.core.x0)).size, new Set(p.tiles.map(t => t.core.y0)).size];
  };
  for (const rs of RS) {
    assert.deepEqual(counts(36, 24, rs), [3, 2]);
    assert.deepEqual(counts(42, 30, rs), [3, 2]);
    assert.deepEqual(counts(48, 36, rs), [3, 3]);
    assert.deepEqual(counts(8.5, 11, rs), [1, 1]);
  }
});

test("cores partition the rect: equal sizes, no gaps, no overlaps", () => {
  const rnd = mulberry32(7);
  for (const rs of RS) for (const [w, h] of PAGES) {
    const rect = pageRect(w, h, rs);
    const plan = planTiles(rect, rs);
    let area = 0;
    for (const a of plan.tiles) {
      area += (a.core.x1 - a.core.x0) * (a.core.y1 - a.core.y0);
      for (const b of plan.tiles) {
        if (a === b) continue;
        const ow = Math.min(a.core.x1, b.core.x1) - Math.max(a.core.x0, b.core.x0);
        const oh = Math.min(a.core.y1, b.core.y1) - Math.max(a.core.y0, b.core.y0);
        assert.ok(ow <= 0 || oh <= 0, `cores ${a.index} and ${b.index} overlap`);
      }
    }
    const full = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    assert.ok(Math.abs(area - full) <= full * 1e-12, `${w}×${h} rs ${rs}: area ${area} vs ${full}`);
    const widths = plan.tiles.map(t => t.core.x1 - t.core.x0), heights = plan.tiles.map(t => t.core.y1 - t.core.y0);
    assert.ok(Math.max(...widths) - Math.min(...widths) < 1e-9 && Math.max(...heights) - Math.min(...heights) < 1e-9, "balanced");
    // every point, including every core boundary and the far edges, is in exactly one core
    const xs = [...new Set(plan.tiles.flatMap(t => [t.core.x0, t.core.x1]))];
    const ys = [...new Set(plan.tiles.flatMap(t => [t.core.y0, t.core.y1]))];
    const pts: [number, number][] = [];
    for (const x of xs) for (const y of ys) pts.push([x, y]);
    for (let i = 0; i < 200; i++) pts.push([rect.x0 + rnd() * (rect.x1 - rect.x0), rect.y0 + rnd() * (rect.y1 - rect.y0)]);
    for (const [x, y] of pts) {
      const owners = plan.tiles.filter(t => inCore(t, x, y)).length;
      assert.equal(owners, 1, `${w}×${h} rs ${rs}: (${x}, ${y}) in ${owners} cores`);
    }
  }
});

test("a point exactly on a core boundary belongs to the core after it", () => {
  const plan = planTiles(pageRect(36, 24, 1), 1);
  const [a, b] = plan.tiles.filter(t => t.core.y0 === 0).sort((p, q) => p.core.x0 - q.core.x0);
  const x = b.core.x0, y = 100;
  assert.equal(a.core.x1, x, "neighbours share the boundary value");
  assert.equal(inCore(b, x, y), true);
  assert.equal(inCore(a, x, y), false);
  // the rect's far edges are closed
  const last = plan.tiles[plan.tiles.length - 1];
  assert.equal(inCore(last, plan.rect.x1, plan.rect.y1), true);
});

test("a region smaller than the cap is one tile, rendered as is", () => {
  const rs = 2, rect = { x0: 300, y0: 200, x1: 1500, y1: 900 };
  const plan = planTiles(rect, rs);
  assert.equal(plan.tiles.length, 1);
  assert.deepEqual(plan.tiles[0].render, rect);
  assert.deepEqual(plan.tiles[0].core, rect);
  assert.equal(factorOf(rs, rect), plan.zoom);
});

test("a marquee in any corner order, off the page origin, tiles the same", () => {
  const rs = 1.37, a = { x0: 123.4, y0: 56.7, x1: 123.4 + 40 * IN * rs, y1: 56.7 + 20 * IN * rs };
  const b = { x0: a.x1, y0: a.y1, x1: a.x0, y1: a.y0 };
  const pa = planTiles(a, rs), pb = planTiles(b, rs);
  assert.deepEqual(pb.rect, a);
  assert.deepEqual(pb.tiles, pa.tiles);
  assert.equal(pa.tiles[0].core.x0, a.x0);
  for (const t of pa.tiles) assert.equal(factorOf(rs, t.render), pa.zoom);
});

test("another DPI plans for that DPI", () => {
  const rs = 2, plan = planTiles(pageRect(36, 24, rs), rs, { dpi: 288 });
  assert.equal(plan.dpi, 288);
  for (const t of plan.tiles) assert.equal(ocrRenderFactor(rs, side(t.render.x0, t.render.x1), side(t.render.y0, t.render.y1), { dpi: 288 }), plan.zoom);
});

test("at 600 DPI the cap binds harder: more, smaller tiles, each still exactly at 600 DPI", () => {
  // (planTiles takes no maxDim: it uses rasterizeRegion's cap, which is what
  // the raster will get.) 600 DPI at rs 1 is zoom 8⅓: 4096 px is 491.5 pt, so
  // a raster side is at most 490 pt and a core at most 346 pt.
  const rs = 1, plan = planTiles(pageRect(36, 24, rs), rs, { dpi: 600 });
  assert.equal(plan.maxSide, 490);
  assert.equal(new Set(plan.tiles.map(t => t.core.x0)).size, Math.ceil(36 * IN / 346));
  assert.equal(new Set(plan.tiles.map(t => t.core.y0)).size, Math.ceil(24 * IN / 346));
  for (const t of plan.tiles) {
    assert.equal(ocrRenderFactor(rs, side(t.render.x0, t.render.x1), side(t.render.y0, t.render.y1), { dpi: 600 }), plan.zoom);
    const d = dimsOf(t.render, plan.zoom);
    assert.ok(d.width <= SCAN_MAX_DIM && d.height <= SCAN_MAX_DIM);
  }
});

test("an overlap that leaves no room for a core is refused", () => {
  assert.throws(() => planTiles(pageRect(36, 24, 1), 1, { overlapPt: 700 }), RangeError);
});

// ── the keep rule, case by case ──────────────────────────────────────────────
// Two tiles side by side at rs 1 (zoom 3): cores [0,1000) and [1000,2000],
// renders [0,1072] and [928,2000]. Text 10 pt tall: near = 6 pt.

const word = (str: string, x0: number, y0: number, x1: number, y1: number, confidence?: number): OcrWord => {
  const w: OcrWord = { str, x: x0, y: y1, w: x1 - x0, h: y1 - y0 };
  if (confidence != null) w.confidence = confidence;
  return w;
};
const twoCols = () => planTiles({ x0: 0, y0: 0, x1: 2000, y1: 500 }, 1);
const keptStrs = (a: { kept: { word: OcrWord }[] }) => a.kept.map(k => k.word.str).sort();

test("the two-tile fixture is what the keep-rule cases assume", () => {
  const plan = twoCols();
  assert.equal(plan.zoom, 3);
  assert.deepEqual(plan.tiles.map(t => [t.core.x0, t.core.x1, t.render.x0, t.render.x1]), [[0, 1000, 0, 1072], [1000, 2000, 928, 2000]]);
});

test("near is max(3 render px, h): the text height, or a vertical line's width", () => {
  assert.equal(nearMargin(word("ROOM", 0, 0, 40, 10), 3), 10);
  assert.equal(nearMargin(word("R", 0, 0, 0.5, 0.5), 3), 1); // 3 render px at zoom 3
  assert.equal(nearMargin(word("VERTICAL", 0, 0, 10, 80), 3), 10);
});

test("a line whole in two tiles is kept once; on a core boundary, from the core after it", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("ON SEAM", 980, 200, 1020, 210, 0)], [word("ON SEAM", 980, 200, 1020, 210, 1)]]);
  assert.equal(a.kept.length, 1);
  assert.equal(a.kept[0].word.confidence, 1, "the owner is the core the centre's in, half-open");
  assert.equal(a.patches.length, 0);
});

test("reads that round a line's centre onto both sides of the boundary keep it once", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("ON SEAM", 979.4, 200, 1020, 210)], [word("ON SEAM", 980, 200.3, 1020.6, 210)]]);
  assert.equal(a.kept.length, 1);
});

test("a discarded duplicate cannot erase a code disagreement", () => {
  const primary = word("S-2", 970, 200, 1010, 210);
  const disputed = { ...primary, codeAlternate: "SS-2" };
  const a = assignLines(twoCols(), [[primary], [disputed]]);
  assert.equal(a.kept.length, 1);
  assert.equal(a.kept[0].word.str, "S-2");
  assert.equal(a.kept[0].word.codeAlternate, "SS-2");
});

test("a merged line retains an unresolved code warning without reusing a fragment's alternate", () => {
  const left = { ...word("PATCH FINISHES THIS AREA", 935, 400, 1055, 410), codeAlternate: "PATCH" };
  const right = word("TCH FINISHES THIS AREA TO MATCH", 945, 400.5, 1100, 410.5);
  const a = assignLines(twoCols(), [[left], [right]]);
  assert.equal(a.kept.length, 1);
  assert.equal(a.kept[0].word.str, "PATCH FINISHES THIS AREA TO MATCH");
  assert.equal(a.kept[0].word.codeAlternate, "");
});

test("two distinct lines from one read are both kept, however much they overlap", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("A", 100, 100, 200, 110), word("B", 100, 101, 200, 111)], []]);
  assert.deepEqual(keptStrs(a), ["A", "B"]);
});

test("a line within h, or 3 render px, of an inner edge is a fragment; of an outer edge, whole", () => {
  const plan = twoCols();
  const a = assignLines(plan, [
    [
      word("HALF H SHORT", 900, 100, 1067, 110),       // 5 pt = 0.5·h from the inner edge at 1072
      word("NEARLY H SHORT", 800, 200, 1063, 210),     // 0.9·h from it
      word("TINY", 1000, 150, 1071.1, 150.5),          // h 0.5: 0.9 pt = 2.7 render px from it
    ],
    [word("OUTER", 1900, 300, 1995, 310)],            // 5 pt from the page's edge
  ]);
  assert.deepEqual(keptStrs(a), ["OUTER"]);
  assert.deepEqual(a.patches.flatMap(p => p.groups.flatMap(g => g.fragments.map(f => f.str))).sort(), ["HALF H SHORT", "NEARLY H SHORT", "TINY"]);
});

// The real engine (ocrSeamsReal.test.ts) drops a glyph its tile's edge cuts,
// box and all, so a cut line starts up to a capital's advance past the edge:
// 0.64–0.79·h measured on the demo plan, where 0.6·h called them whole.
test("a line whose cut glyph was dropped, starting 0.72·h inside the edge, is a fragment and is read whole by a patch", () => {
  const plan = twoCols();
  // tile 1's raster starts at 928; tile 0 read nothing of the row
  const cut = word("TCH FINISHES THIS AREA", 928 + 7.2, 380, 1150, 390);
  const a = assignLines(plan, [[], [cut]]);
  assert.deepEqual(keptStrs(a), []);
  assert.equal(a.patches.length, 1);
  assert.ok(a.patches[0].render.x0 < 914, `the patch reaches past the cut: ${JSON.stringify(a.patches[0].render)}`);
  const whole = word("PATCH FINISHES THIS AREA", 914, 380, 1150, 390);
  assert.deepEqual(joinPatches(a, [[whole]]), [whole]);
});

test("a line 1.1·h inside an inner edge is whole: no patch", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[], [word("142", 928 + 11, 380, 960, 390)]]);
  assert.deepEqual(keptStrs(a), ["142"]);
  assert.equal(a.patches.length, 0);
});

// ── one row read as two overlapping pieces ───────────────────────────────────
// Each tile read a piece of one row whole (its cut glyphs dropped by more
// than the near margin), so both are kept; they overlap in the tiles'
// overlap, and the left piece starts before the right one. They are one row
// only when the text proves it: the left piece ends with what the right one
// starts with, and the boxes overlap by about that shared text's width.
// Characters here are 5 pt wide (w / length).

test("two pieces of one row merge into one line, joined where their texts overlap", () => {
  const plan = twoCols();
  // shared "TCH FINISHES THIS AREA": 22 characters, 110 pt, the boxes' overlap
  const left = word("PATCH FINISHES THIS AREA", 935, 400, 1055, 410);
  const right = word("TCH FINISHES THIS AREA TO MATCH", 945, 400.5, 1100, 410.5);
  const a = assignLines(plan, [[left], [right]]);
  assert.equal(a.patches.length, 0);
  assert.deepEqual(a.kept.map(k => k.word), [{ str: "PATCH FINISHES THIS AREA TO MATCH", x: 935, y: 410.5, w: 165, h: 10.5 }]);
});

test("the boxes may overlap by the shared text's width give or take under a character: 0.45 of one off still joins", () => {
  const plan = twoCols();
  // as test 1, the right piece 2.25 pt (0.45 of a 5 pt character) further
  // right: the overlap is 107.75 for 110 of shared text (the demo's doubled
  // row was 3.5 px off on 7.7 px characters)
  const left = word("PATCH FINISHES THIS AREA", 935, 400, 1055, 410);
  const right = word("TCH FINISHES THIS AREA TO MATCH", 947.25, 400, 1102.25, 410);
  const a = assignLines(plan, [[left], [right]]);
  assert.deepEqual(a.kept.map(k => k.word), [{ str: "PATCH FINISHES THIS AREA TO MATCH", x: 935, y: 410, w: 167.25, h: 10 }]);
});

test("the shared text's width is taken in each piece's own characters: spaced letters in one, not the other", () => {
  const plan = twoCols();
  // "FINISH" spans 11 characters in the left piece (5 pt each, 55 pt) and 6
  // in the right one (55/6 pt each, 55 pt): the boxes overlap by 55
  const left = word("ROOM F I N I S H", 960, 400, 1040, 410);
  const right = word("FINISH SCHEDULE", 985, 400, 1122.5, 410);
  const a = assignLines(plan, [[left], [right]]);
  assert.deepEqual(a.kept.map(k => k.word.str), ["ROOM F I N I S H SCHEDULE"]);
});

test("the text join allows one misread glyph in ten where the pieces overlap", () => {
  const plan = twoCols();
  // shared "PLAN FOR ADDIT": 14 characters, 70 pt
  const left = word("SEE FINISH PLAN FOR ADDIT", 930, 400, 1055, 410);
  const right = word("PLAN F0R ADDITIONAL INFORMATION", 985, 400, 1140, 410);
  const a = assignLines(plan, [[left], [right]]);
  assert.deepEqual(a.kept.map(k => k.word.str), ["SEE FINISH PLAN FOR ADDITIONAL INFORMATION"]);
});

test("two different lines overlapping on one row with no shared text both stay, unspliced", () => {
  const plan = twoCols();
  // each whole in its tile; boxes overlap 40 pt
  const a = assignLines(plan, [[word("DOOR SCHEDULE", 900, 400, 1040, 410)], [word("SEE NOTE 4", 1000, 400, 1100, 410)]]);
  assert.deepEqual(keptStrs(a), ["DOOR SCHEDULE", "SEE NOTE 4"]);
  // nor a misread overlap: "FGHIJ" read as "VWXYZ"
  const b = assignLines(plan, [[word("ABCDEFGHIJ", 900, 400, 1000, 410)], [word("VWXYZKLMNO", 950, 400, 1050, 410)]]);
  assert.deepEqual(keptStrs(b), ["ABCDEFGHIJ", "VWXYZKLMNO"]);
});

test("a short shared token doesn't join two cells whose boxes overlap by more than it", () => {
  const plan = twoCols();
  // "P-1" ends one and starts the other (3 characters, 15 pt), but the boxes
  // overlap by 25 pt (IoU 0.42): two cells, not one row read twice
  const a = assignLines(plan, [[word("CPT-1 P-1", 1010, 400, 1055, 410)], [word("P-1 RB-1", 1030, 400, 1070, 410)]]);
  assert.deepEqual(keptStrs(a), ["CPT-1 P-1", "P-1 RB-1"]);
  // or by less: 5 pt
  const b = assignLines(plan, [[word("CPT-1 P-1", 1010, 400, 1055, 410)], [word("P-1 RB-1", 1050, 400, 1090, 410)]]);
  assert.deepEqual(keptStrs(b), ["CPT-1 P-1", "P-1 RB-1"]);
});

test("one or two shared characters don't join, even where the boxes overlap by just that", () => {
  const plan = twoCols();
  for (const n of [1, 2]) {
    const left = "ABCDEFGHIJ", right = left.slice(-n) + "KLMNOPQRS".slice(0, 10 - n);
    const a = assignLines(plan, [[word(left, 1000, 400, 1050, 410)], [word(right, 1050 - 5 * n, 400, 1100 - 5 * n, 410)]]);
    assert.deepEqual(keptStrs(a), [left, right].sort(), `${n} shared`);
  }
});

test("two words on one row overlapping by less than h, with no shared text, stay two lines", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("ROOM", 990, 400, 1040, 410)], [word("101", 1035, 400, 1060, 410)]]);
  assert.deepEqual(keptStrs(a), ["101", "ROOM"]);
});

test("one ink read whole by two tiles as different text of similar length is kept once, from the centre's owner", () => {
  const plan = twoCols();
  // tile 1 owns the centre (1012 ≥ 1000); tile 0's misread has more characters
  const a = assignLines(plan, [[word("ma en Yl", 990, 401, 1034, 411)], [word("WHITE", 990, 400, 1034, 410)]]);
  assert.deepEqual(keptStrs(a), ["WHITE"]);
});

test("a read with more characters replaces nothing unless it is a line height longer: 0.75·h isn't, 1.0·h is", () => {
  const plan = twoCols();
  // tile 1's "WHITE" (44 long, h 10) owns the centre; tile 0's misread holds
  // all of it and has more characters
  const white = word("WHITE", 990, 400, 1034, 410);
  const once = assignLines(plan, [[word("ma en Yl", 990, 400, 1041.5, 410)], [white]]);
  assert.deepEqual(keptStrs(once), ["WHITE"], "7.5 longer: the same ink, a duplicate by IoU");
  const both = assignLines(plan, [[word("ma en Yl", 990, 400, 1044, 410)], [white]]);
  assert.deepEqual(keptStrs(both), ["WHITE", "ma en Yl"], "10 longer: more ink, and its text doesn't hold WHITE, so both stay");
});

test("a patch edge across sits in the clear gap beside its band, not on a neighbouring row", () => {
  const plan = twoCols();
  const frags = [word("ROW", 800, 300, 1072, 310), word("ROW", 928, 300, 1200, 310)];
  // a row above, its foot on the edge a patch sized only to the band would have
  const above = word("ABOVE", 900, 270, 1000, 280);
  const a = assignLines(plan, [[frags[0], above], [frags[1], above]]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.y0 <= 270 - 5, `top edge clear of the row above: ${JSON.stringify(r)}`);
  assert.ok(r.y1 >= 310 + 5);
  // a fragment counts too, and a row far off doesn't move the edge
  const b = assignLines(plan, [[frags[0], word("FAR", 900, 200, 1000, 210)], [frags[1], word("FAR", 900, 200, 1000, 210)]]);
  assert.ok(b.patches[0].render.y0 > 215, JSON.stringify(b.patches[0].render));
});

test("a fragment inside a kept whole line is dropped before grouping: no patch", () => {
  const plan = twoCols();
  const whole = word("ROOM 101 FLOOR", 940, 100, 1060, 110);
  const a = assignLines(plan, [
    [word("ROOM 101 FLO", 940, 100, 1072, 110), word("ROOM 101 FLOOR", 939.5, 100.5, 1072, 110.5)], // cut; and one stretched to the edge by unpad
    [whole],
  ]);
  assert.deepEqual(keptStrs(a), ["ROOM 101 FLOOR"]);
  assert.equal(a.patches.length, 0);
  assert.deepEqual(joinPatches(a, []), [whole]);
});

test("a fragment with no partner past its cut gets a patch reaching toward the cap on that side only", () => {
  const plan = planTiles({ x0: 0, y0: 0, x1: 3000, y1: 500 }, 1);
  assert.equal(plan.tiles.length, 3);
  // tile 1 read nothing of the line's right half
  const a = assignLines(plan, [[word("CUT OFF", 800, 300, 1072, 310)], [], []]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.x0 >= 800 - 21 && r.x0 < 800, `fixed end padded, not extended: ${r.x0}`);
  assert.ok(Math.abs(r.x1 - r.x0 - plan.maxSide) < 1e-6, `open end extended to the cap: ${JSON.stringify(r)}`);
  assert.equal(factorOf(1, r), plan.zoom);
});

test("a patch near the page edge stays on the page", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("FROM THE EDGE", 3, 2, 1072, 12)], [word("E EDGE", 928, 2, 1100, 12)]]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.x0 >= 0 && r.y0 >= 0 && r.x1 <= 2000 && r.y1 <= 500, JSON.stringify(r));
  const line = word("FROM THE EDGE", 3, 2, 1100, 12);
  assert.deepEqual(joinPatches(a, [[line]]), [line], "whole in the patch: the page edge isn't an inner edge");
});

test("a straddler that fits the cap but not its end margins gets no patch", () => {
  const plan = twoCols();
  assert.equal(plan.maxSide, 1364);
  // End margins: 2 near margins and 2 render px at each end, 20⅔ pt. 1322
  // long fits (1322 + 41⅓ ≤ 1364); 1330 is under the cap but doesn't.
  const fits = assignLines(plan, [[word("FITS", 330, 300, 1072, 310)], [word("FITS", 928, 300, 1652, 310)]]);
  assert.equal(fits.patches.length, 1, "1322 long fits");
  const a = assignLines(plan, [[word("NEARLY CAP LONG", 320, 300, 1072, 310)], [word("CAP LONG", 928, 300, 1650, 310)]]);
  assert.equal(a.patches.length, 0);
  assert.ok(joinPatches(a, []).every(l => l.clipped));
});

test("a straddler becomes one patch along its line, at the target DPI, and is read whole from it", () => {
  const plan = twoCols();
  const line = word("A LONG STRADDLING NOTE", 800, 300, 1200, 310);
  const a = assignLines(plan, [[word("A LONG STRADDL", 800, 300, 1072, 310)], [word("DDLING NOTE", 928, 300, 1200, 310)]]);
  assert.equal(a.kept.length, 0);
  assert.equal(a.patches.length, 1);
  const p = a.patches[0];
  assert.equal(p.axis, "h");
  assert.ok(p.render.x0 <= 800 - 6 && p.render.x1 >= 1200 + 6, "the patch holds the whole line with room to spare");
  assert.ok(p.render.x1 - p.render.x0 <= 400 + 2 * 21, `sized to the line, not the cap: ${JSON.stringify(p.render)}`);
  assert.ok(p.render.y0 < 300 && p.render.y1 > 310 && p.render.y1 - p.render.y0 < 100, "and a narrow band around it");
  assert.equal(factorOf(1, p.render), plan.zoom);
  assert.deepEqual(joinPatches(a, [[line]]), [line]);
});

test("the patch axis follows the edge the fragment is near, not its shape", () => {
  // One column, two rows: the inner edge is horizontal. A two-glyph fragment
  // of a vertical line there is wider than tall.
  const plan = planTiles({ x0: 0, y0: 0, x1: 500, y1: 2000 }, 1);
  assert.equal(plan.tiles.length, 2);
  const edge = plan.tiles[0].render.y1;
  const a = assignLines(plan, [[word("AB", 200, edge - 12, 215, edge)], []]);
  assert.equal(a.patches.length, 1);
  assert.equal(a.patches[0].axis, "v");
  const r = a.patches[0].render;
  assert.ok(r.y1 - r.y0 > r.x1 - r.x0, `extends along y: ${JSON.stringify(r)}`);
});

test("a patch keeps only whole lines in its band that aren't already kept; overlapping distinct lines both survive", () => {
  const plan = twoCols();
  const q = word("Q NOTE", 940, 400, 1060, 410);         // whole in both tiles
  const p = word("P STRADDLING THE SEAM", 900, 405, 1100, 415); // overlaps Q, IoU ≈ 0.23, half of Q inside it
  const a = assignLines(plan, [
    [q, word("P STRADDLING T", 900, 405, 1072, 415)],
    [q, word("G THE SEAM", 928, 405, 1100, 415)],
  ]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.y0 + 12 < 405, "room for a line above the band inside the patch");
  const out = joinPatches(a, [[
    q,                                                   // read again: a duplicate
    p,
    word("ABOVE", 1000, r.y0 + 6, 1100, r.y0 + 12),      // clear of the patch's edges, outside the band
    word("EDGE", r.x1 - 50, 406, r.x1, 416),             // in the band, cut by the patch's edge
  ]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["P STRADDLING THE SEAM", "Q NOTE"]);
});

test("kept grows after each patch: two patches over one line keep it once", () => {
  const plan = twoCols();
  const a = assignLines(plan, [
    [word("ONE", 800, 300, 1072, 310), word("TWO", 800, 309, 1072, 319)],
    [word("ONE", 928, 300, 1200, 310), word("TWO", 928, 309, 1200, 319)],
  ]);
  // Neighbouring rows pack into one patch; read it twice, as two patches.
  assert.equal(a.patches.length, 1);
  const twice = { ...a, patches: [a.patches[0], { ...a.patches[0], index: 1 }] };
  const both = word("ONE TWO", 800, 302, 1200, 316);
  assert.deepEqual(joinPatches(twice, [[both], [both]]).map(l => l.str), ["ONE TWO"]);
});

test("a line longer than a patch holds is kept as its fragments, flagged clipped, with no patch read", () => {
  const plan = planTiles({ x0: 0, y0: 0, x1: 4000, y1: 500 }, 1);
  const reads = plan.tiles.map(t => [word(`PART ${t.index}`, Math.max(100, t.render.x0), 200, Math.min(3900, t.render.x1), 210)]);
  const a = assignLines(plan, reads);
  assert.equal(a.patches.length, 0);
  const out = joinPatches(a, []);
  assert.deepEqual(out.map(l => l.str).sort(), plan.tiles.map(t => `PART ${t.index}`).sort());
  assert.ok(out.every(l => l.clipped === true));
});

test("a patch that reads no whole line keeps the fragments, flagged clipped", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("LEFT PART", 800, 300, 1072, 310)], [word("RIGHT PART", 928, 300, 1200, 310)]]);
  const out = joinPatches(a, [[]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["LEFT PART", "RIGHT PART"]);
  assert.ok(out.every(l => l.clipped === true));
});

test("a patch line off its fragments is kept only where it overlaps no kept line: a tile's line read again differently isn't doubled", () => {
  const plan = twoCols();
  // two rows pack into one patch; the lower one is longer. A tile read
  // "NOTE A" whole, in the short row's band past its fragments.
  const note = word("NOTE A", 1250, 300, 1350, 310);
  const a = assignLines(plan, [
    [word("SHORT ROW", 800, 300, 1072, 310), word("LONG ROW", 600, 330, 1072, 340)],
    [word("SHORT ROW", 928, 300, 1200, 310), word("LONG ROW", 928, 330, 1400, 340), note],
  ]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.x0 < 600 && r.x1 > 1400);
  const out = joinPatches(a, [[
    word("SHORT ROW", 800, 300, 1200, 310),
    word("LONG ROW", 600, 330, 1400, 340),
    word("N0TE 4", 1252, 300, 1340, 310), // the kept note, misread and a little shorter: not a second line
  ]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["LONG ROW", "NOTE A", "SHORT ROW"]);
});

test("a whole line only a patch read, in a group's band and clear of every kept line, is kept once (#488)", () => {
  const plan = twoCols();
  // Two straddling rows pack into one patch. On the short row the tiles read
  // only the straddler; the cell beside it, "P-5", came back from neither
  // tile, so it has no fragment for the patch line to lie over.
  const a = assignLines(plan, [
    [word("SHORT ROW", 800, 300, 1072, 310), word("LONG ROW", 600, 330, 1072, 340)],
    [word("SHORT ROW", 928, 300, 1200, 310), word("LONG ROW", 928, 330, 1400, 340)],
  ]);
  assert.equal(a.patches.length, 1);
  const p5 = word("P-5", 1250, 300, 1290, 310);
  const read = [word("SHORT ROW", 800, 300, 1200, 310), word("LONG ROW", 600, 330, 1400, 340), p5];
  const out = joinPatches(a, [read]);
  assert.deepEqual(out.map(l => l.str).sort(), ["LONG ROW", "P-5", "SHORT ROW"]);
  assert.ok(out.every(l => !l.clipped));
  assert.deepEqual(out.find(l => l.str === "P-5"), p5, "as the patch read it");
  // two patches over the same row keep it once
  const twice = { ...a, patches: [a.patches[0], { ...a.patches[0], index: 1 }] };
  assert.deepEqual(joinPatches(twice, [read, read]).map(l => l.str).sort(), ["LONG ROW", "P-5", "SHORT ROW"]);
});

test("two overlapping lines only a patch read are both kept: one read's lines are never duplicates", () => {
  const plan = twoCols();
  // the long row widens the shared patch past the short row's end
  const a = assignLines(plan, [
    [word("SHORT ROW", 800, 300, 1072, 310), word("LONG ROW", 600, 330, 1072, 340)],
    [word("SHORT ROW", 928, 300, 1200, 310), word("LONG ROW", 928, 330, 1400, 340)],
  ]);
  assert.equal(a.patches.length, 1);
  const out = joinPatches(a, [[
    word("SHORT ROW", 800, 300, 1200, 310), word("LONG ROW", 600, 330, 1400, 340),
    word("P-5", 1250, 300, 1290, 310), word("NOTE", 1280, 302, 1340, 312),
  ]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["LONG ROW", "NOTE", "P-5", "SHORT ROW"]);
});

test("a patch line off its fragments that partly overlaps a kept line is not added", () => {
  const plan = twoCols();
  const kept = word("KEPT NOTE", 1250, 300, 1350, 310);
  const a = assignLines(plan, [
    [word("SHORT ROW", 800, 300, 1072, 310)],
    [word("SHORT ROW", 928, 300, 1200, 310), kept],
  ]);
  assert.equal(a.patches.length, 1);
  const out = joinPatches(a, [[
    word("SHORT ROW", 800, 300, 1200, 310),
    word("TE EXTRA", 1320, 301, 1420, 311), // in the band, a third of it over the kept note
  ]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["KEPT NOTE", "SHORT ROW"]);
});

test("a patch line holding a kept line and its exact text replaces it; a misread keeps both", () => {
  const plan = twoCols();
  // Tile 0 read "ROOM 101" whole (its cut fell in a wide gap) and the rest
  // of the row as a fragment; the patch reads the row as one line.
  const room = word("ROOM 101", 905, 100, 960, 110);
  const a = assignLines(plan, [
    [room, word("FLOOR FINISH", 1000, 100, 1072, 110)],
    [word("FINISH TYPE A", 928, 100, 1300, 110)],
  ]);
  assert.deepEqual(keptStrs(a), ["ROOM 101"]);
  assert.equal(a.patches.length, 1);
  assert.ok(a.patches[0].render.x0 < 905, "the patch reaches over the kept part of the row");
  const exact = word("ROOM 101 FLOOR FINISH TYPE A", 905, 100, 1300, 110);
  assert.deepEqual(joinPatches(a, [[exact]]).map(l => l.str), [exact.str]);
  // one glyph misread: not provably the same text, so both stay (for search,
  // a duplicate beats a miss)
  const misread = word("R0OM 101 FLOOR FINISH TYPE A", 905, 100, 1300, 110);
  assert.deepEqual(joinPatches(a, [[misread]]).map(l => l.str).sort(), [misread.str, "ROOM 101"]);
});

test("a patch line inside a longer kept line with its text is the duplicate: the kept line stays", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("AAAA BBBB CCCC", 900, 100, 1072, 110)], [word("BBBB CCCC DDDD", 928, 100, 1150, 110)]]);
  assert.equal(a.patches.length, 1);
  // a longer kept line on that row, from another read
  const kept = word("AAAA BBBB CCCC DDDD EEEE FFFF", 900, 100, 1400, 110);
  const withKept = { ...a, kept: [{ word: kept, src: "t0" }] };
  // exact, and one edit in ten or more characters: the duplicate (IoU 0.3,
  // so only containment says so)
  for (const text of ["BBBB CCCC DDDD", "B8BB CCCC DDDD"]) {
    const out = joinPatches(withKept, [[word(text, 1000, 100, 1150, 110)]]);
    assert.deepEqual(out.map(l => l.str), [kept.str], text);
  }
  // under ten characters the text must match exactly: "B8BB" isn't in it
  const out = joinPatches(withKept, [[word("B8BB", 970, 100, 1020, 110)]]);
  assert.deepEqual(out.map(l => l.str).sort(), [kept.str, "B8BB"]);
});

test("a short kept line inside a longer patch line survives unless its text is there exactly", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("ROOM 1O1 FLOOR", 900, 100, 1072, 110)], [word("FLOOR", 928, 100, 1150, 110)]]);
  const tag = word("X", 1000, 101, 1008, 109);
  const withKept = { ...a, kept: [{ word: tag, src: "t0" }] };
  const row = word("ROOM 1O1 FLOOR", 900, 100, 1150, 110);
  assert.deepEqual(joinPatches(withKept, [[row]]).map(l => l.str).sort(), [row.str, "X"]);
  // and the reverse: a one-letter patch line inside a longer kept line
  const withRow = { ...a, kept: [{ word: row, src: "t0" }] };
  assert.deepEqual(joinPatches(withRow, [[word("X", 1000, 101, 1008, 109)]]).map(l => l.str).sort(), [row.str, "X"]);
});

test("containment thresholds: 80% of the kept box inside to replace, 80% of the patch line inside to be its duplicate", () => {
  const plan = twoCols();
  const a = assignLines(plan, [[word("AAAA BBBB CCCC", 900, 100, 1072, 110)], [word("CCCC DDDD", 928, 100, 1150, 110)]]);
  const line = word("AAAA BBBB CCCC DDDD", 900, 100, 1150, 110);
  // replace: a kept "DDDD" 25 wide, 20 (80%) or 19 (76%) of it inside the patch line
  for (const [x0, replaced] of [[1130, true], [1131, false]] as const) {
    const k = word("DDDD", x0, 100, x0 + 25, 110);
    const out = joinPatches({ ...a, kept: [{ word: k, src: "t1" }] }, [[line]]).map(l => l.str).sort();
    assert.deepEqual(out, replaced ? [line.str] : [line.str, "DDDD"].sort(), `kept at ${x0}`);
  }
  // duplicate: a patch "DDDD" 25 wide, 80% or 76% inside a kept line
  for (const [x0, dup] of [[1130, true], [1131, false]] as const) {
    const out = joinPatches({ ...a, kept: [{ word: line, src: "t1" }] }, [[word("DDDD", x0, 100, x0 + 25, 110)]]).map(l => l.str).sort();
    assert.deepEqual(out, dup ? [line.str] : [line.str, "DDDD"].sort(), `patch line at ${x0}`);
  }
});

test("one short line read by two tiles a pixel apart, a glyph different, is kept once: IoU alone says so", () => {
  const plan = twoCols();
  // Under ten characters the text must match exactly, so containment can't
  // call it a duplicate; the boxes' IoU (≈ 0.78) must.
  const a = assignLines(plan, [[word("0N SEAM", 981, 201, 1021, 211)], [word("ON SEAM", 980, 200, 1020, 210)]]);
  assert.equal(a.kept.length, 1);
  assert.equal(a.kept[0].word.str, "ON SEAM", "the centre's owner's read");
  assert.equal(a.patches.length, 0);
});

test("a line cut at both ends of a middle tile gets a patch centred on it, the cap wide", () => {
  const plan = planTiles({ x0: 0, y0: 0, x1: 3000, y1: 500 }, 1);
  assert.deepEqual(plan.tiles.map(t => [t.render.x0, t.render.x1]), [[0, 1072], [928, 2072], [1928, 3000]]);
  // Neither neighbour read any of it, so the line may run on past either end.
  const a = assignLines(plan, [[], [word("RUNS PAST BOTH EDGES", 930, 300, 2070, 310)], []]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(Math.abs(r.x1 - r.x0 - plan.maxSide) < 1e-6, `the cap wide: ${JSON.stringify(r)}`);
  assert.ok(Math.abs((r.x0 + r.x1) / 2 - 1500) < 1e-6, `centred on the line, not reaching one way: ${JSON.stringify(r)}`);
});

test("two pieces of one line a hair apart along it are one straddler: one patch", () => {
  const plan = planTiles({ x0: 0, y0: 0, x1: 3000, y1: 500 }, 1);
  // The middle tile read the line as two boxes split at a word gap 3 pt wide
  // (under the 6 pt near margin), one at each inner edge.
  const head = word("HEAD OF A LINE", 930, 300, 1000, 310), tail = word("AND ITS TAIL", 1003, 300, 2070, 310);
  const a = assignLines(plan, [[], [head, tail], []]);
  assert.equal(a.patches.length, 1, "one raster for the line, not one per piece");
  assert.deepEqual(a.patches[0].groups.map(g => g.fragments.map(f => f.str)), [["HEAD OF A LINE", "AND ITS TAIL"]]);
  const line = word("HEAD OF A LINE AND ITS TAIL", 930, 300, 2070, 310);
  assert.deepEqual(joinPatches(a, [[line]]), [line]);
});

test("a straddler whose kept neighbours would grow its patch past the cap is still read whole", () => {
  const plan = twoCols();
  const left = word("LEFT NEIGHBOUR", 20, 300, 400, 310), right = word("RIGHT NEIGHBOUR", 1204, 300, 1990, 310);
  const a = assignLines(plan, [[left, word("STRAD", 404, 300, 1072, 310)], [word("DDLE", 928, 300, 1200, 310), right]]);
  assert.deepEqual(keptStrs(a), ["LEFT NEIGHBOUR", "RIGHT NEIGHBOUR"]);
  assert.equal(a.patches.length, 1);
  const r = a.patches[0].render;
  assert.ok(r.x0 < 404 && r.x1 > 1200 && r.x1 - r.x0 <= plan.maxSide, JSON.stringify(r));
  const out = joinPatches(a, [[word("STRADDLE", 404, 300, 1200, 310)]]);
  assert.deepEqual(out.map(l => l.str).sort(), ["LEFT NEIGHBOUR", "RIGHT NEIGHBOUR", "STRADDLE"]);
  assert.ok(out.every(l => !l.clipped));
});

test("a patch grows over a kept line only on the same row: half a line height shared", () => {
  const plan = twoCols();
  const frags = [[word("ROW", 800, 300, 1072, 310)], [word("ROW", 928, 300, 1200, 310)]];
  for (const [y0, grows] of [[305, true], [306, false]] as const) {
    const a = assignLines(plan, [[...frags[0]], [...frags[1], word("NEXT", 1203, y0, 1500, y0 + 10)]]);
    assert.equal(a.patches.length, 1);
    assert.equal(a.patches[0].render.x1 > 1500, grows, `neighbour at y ${y0}`);
  }
});

// ── the whole pipeline against ground truth ──────────────────────────────────
// A fake recognizer that behaves like the engine at a raster edge:
//   • fixed-width glyphs (advance 0.45·size, ink inset 0.05·size each side);
//   • a glyph cut by the render edge is not read (no half glyphs), but its
//     visible ink is still in the detector's box, as it would be;
//   • so a cut that falls in the gap between words ends the text, and the
//     ink, short of the edge;
//   • a horizontal line's box goes through ppu's padding (replicated from
//     ppu-ocv detectRegions, as in ocrRaster.test.ts, detector at crop size)
//     and the real unpadCropBox and cropBoxToWord, so rounding matches the
//     worker.
// Vertical lines are fake-only: the engine reading rotated text isn't shown.
// ppu would pad a vertical box by its long side, so they skip the padding and
// emit the rounded ink box.

const ADV = 0.45, SB = 0.05;

/** A line on the synthetic page. `patch` is what a patch reads in its place
 * when the engine reads it differently from the tiles (merged with its
 * neighbour, split, a glyph misread); [] when a merge took it. */
interface Truth { text: string; dir: "h" | "v"; a0: number; c0: number; size: number; patch?: Truth[]; expect?: Truth[] }

/** What the patches see. */
const asPatched = (truth: Truth[]) => truth.flatMap(g => g.patch ?? [g]);
/** What the join must return: what the patches see, unless noted. */
const expected = (truth: Truth[]) => truth.flatMap(g => g.expect ?? g.patch ?? [g]);

function truthBox(g: Truth): Rect {
  const s0 = g.a0 + SB * g.size, s1 = g.a0 + (g.text.length * ADV - SB) * g.size;
  return g.dir === "h" ? { x0: s0, y0: g.c0, x1: s1, y1: g.c0 + g.size } : { x0: g.c0, y0: s0, x1: g.c0 + g.size, y1: s1 };
}

function ppuPad(ink: CropBox, crop: { width: number; height: number }, pad = OCR_DETECTION_PADDING): CropBox {
  const bboxH = ink.y1 - ink.y0;
  const vPad = Math.round(bboxH * pad.vertical), hPad = Math.round(bboxH * pad.horizontal);
  return {
    x0: Math.max(0, ink.x0 - hPad), y0: Math.max(0, ink.y0 - vPad),
    x1: Math.min(crop.width, ink.x1 + hPad), y1: Math.min(crop.height, ink.y1 + vPad),
  };
}

function fakeRead(truth: Truth[], render: Rect, zoom: number): OcrWord[] {
  const crop = renderDims({ rect: render, zoom });
  const out: OcrWord[] = [];
  for (const g of truth) {
    const h = g.dir === "h";
    const [ra0, ra1, rc0, rc1] = h ? [render.x0, render.x1, render.y0, render.y1] : [render.y0, render.y1, render.x0, render.x1];
    if (g.c0 < rc0 || g.c0 + g.size > rc1) continue; // cut across: every glyph is cut
    let first = -1, last = -1, ink0 = Infinity, ink1 = -Infinity;
    for (let i = 0; i < g.text.length; i++) {
      if (g.text[i] === " ") continue;
      const i0 = g.a0 + (i * ADV + SB) * g.size, i1 = g.a0 + ((i + 1) * ADV - SB) * g.size;
      if (i1 <= ra0 || i0 >= ra1) continue;
      ink0 = Math.min(ink0, Math.max(i0, ra0));
      ink1 = Math.max(ink1, Math.min(i1, ra1));
      if (i0 >= ra0 && i1 <= ra1) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) continue;
    const px = (v: number, o: number) => Math.round((v - o) * zoom);
    const a0 = px(ink0, ra0), a1 = px(ink1, ra0), c0 = px(g.c0, rc0), c1 = px(g.c0 + g.size, rc0);
    let box: CropBox = h ? { x0: a0, y0: c0, x1: a1, y1: c1 } : { x0: c0, y0: a0, x1: c1, y1: a1 };
    if (h) box = unpadCropBox(ppuPad(box, crop), crop, OCR_DETECTION_PADDING);
    out.push(cropBoxToWord(g.text.slice(first, last + 1), box, { rect: render, zoom }));
  }
  return out;
}

// Deterministic text: an id, then words of 2–7 letters and digits.
function makeText(id: number, chars: number, rnd: () => number): string {
  let s = `L${id}`;
  while (s.length < chars) {
    s += " ";
    const n = 2 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) s += "ABCDEFGHJKLMNPRSTUVWXY0123456789"[Math.floor(rnd() * 32)];
  }
  s = s.slice(0, chars);
  return s.endsWith(" ") ? s.slice(0, -1) + "Z" : s;
}

/** Lines placed against the plan's seams: short ones on a seam and centred
 * exactly on a core boundary, ones longer than the overlap, straddlers up to
 * the patch cap, a seam cut falling in a word gap, 4-way corners, a line cut
 * across by a tile's edge, two distinct overlapping lines, vertical lines
 * across a horizontal seam, and filler inside every core. */
function layout(plan: TilePlan): Truth[] {
  const rs = plan.rs, size = 10 * rs, adv = ADV * size, inch = IN * rs, ov = plan.overlap;
  const xs = [...new Set(plan.tiles.map(t => t.core.x0))].sort((a, b) => a - b);
  const ys = [...new Set(plan.tiles.map(t => t.core.y0))].sort((a, b) => a - b);
  assert.ok(xs.length >= 3 && ys.length >= 2, "the layout needs 3 columns and 2 rows");
  const sx = xs[1], sy = ys[1];
  const rnd = mulberry32(Math.round(rs * 1000) + xs.length * 7 + ys.length);
  const out: Truth[] = [];
  const add = (dir: "h" | "v", a0: number, c0: number, chars: number) =>
    out.push({ dir, a0, c0, size, text: makeText(out.length, chars, rnd) });
  const charsFor = (len: number) => Math.round(len / adv);
  /** start so the line's box is centred on `c` */
  const centred = (c: number, chars: number) => c - (chars * ADV * size) / 2;
  const band = (j: number) => ys[0] + inch + j * 0.5 * inch;
  const maxLen = plan.maxSide - 4 * size - 30 / plan.zoom; // less the patch's end margins

  // horizontal, across the first vertical seam, one band each
  let n = charsFor(0.6 * inch); add("h", centred(sx, n), band(0), n);                  // centred on the core boundary
  n = charsFor(0.6 * inch); add("h", centred(sx + 0.2 * inch, n), band(1), n);        // on the seam, off centre
  n = charsFor(1.5 * inch); add("h", centred(sx - 0.3 * inch, n), band(2), n);        // longer than the overlap
  n = charsFor(3 * inch); add("h", centred(sx + 0.4 * inch, n), band(3), n);          // straddlers…
  n = charsFor(8 * inch); add("h", centred(sx - 1.1 * inch, n), band(4), n);
  n = Math.floor(maxLen / adv); add("h", centred(sx, n), band(5), n);                 // …up to the patch cap
  {
    // the tile's inner edge at sx + ov falls in a word gap, 0.3·size past the last ink
    const text = makeText(out.length, charsFor(5 * inch), rnd);
    const k = text.indexOf(" ", Math.floor(text.length / 2));
    out.push({ dir: "h", size, text, c0: band(6), a0: sx + ov - (k * ADV + 0.25) * size });
  }
  {
    // two distinct overlapping lines, IoU ≈ 0.23: a straddler, and a line
    // whole in the left tile, 0.6 of a line lower
    n = charsFor(2.2 * inch); add("h", centred(sx, n), band(7), n);
    n = charsFor(1.9 * inch); add("h", centred(sx - 0.1 * inch, n), band(7) + 0.6 * size, n);
  }
  // The patch reads differently from the tiles (seeded):
  const misread = (t: string, i: number) => t.slice(0, i) + (t[i] === "Q" ? "O" : "Q") + t.slice(i + 1);
  {
    // split: the 3 in straddler in band 3 comes back as two lines
    const g = out[3], k = g.text.indexOf(" ", Math.floor(g.text.length / 2));
    g.patch = [{ ...g, text: g.text.slice(0, k) }, { ...g, text: g.text.slice(k + 1), a0: g.a0 + (k + 1) * adv }];
  }
  {
    // misread: one glyph of the 8 in straddler in band 4
    const g = out[4], i = g.text.length - 3;
    g.patch = [{ ...g, text: misread(g.text, i) }];
  }
  for (const [j, bad] of [[8, false], [9, true]] as const) {
    // merge: a straddler, then one space, then a line whole in the right
    // tile; the patch reads both as one line (in band 9 with a glyph of the
    // second misread)
    const np = charsFor(2.5 * inch), nq = charsFor(1 * inch);
    const a0 = centred(sx - 0.3 * inch, np);
    add("h", a0, band(j), np);
    const p = out[out.length - 1];
    add("h", a0 + (np + 1) * adv, band(j), nq);
    const q = out[out.length - 1];
    const text = `${p.text} ${q.text}`;
    p.patch = [{ ...p, text: bad ? misread(text, text.length - 2) : text }];
    q.patch = [];
    // a misread merge doesn't provably hold q's text: q stays too
    if (bad) q.expect = [{ ...q, patch: undefined }];
  }
  // 4-way corner at (sx, sy)
  n = charsFor(0.6 * inch); add("h", centred(sx, n), sy - size / 2, n);                // centred on the corner
  n = charsFor(4 * inch); add("h", centred(sx + 0.3 * inch, n), sy + 1.5 * size, n);   // straddler through the corner
  n = charsFor(4 * inch); add("h", centred(sx - 0.2 * inch, n), sy + ov - size / 2, n); // cut across by the top tiles' edge
  n = charsFor(0.8 * inch); add("h", centred(xs[0] + 3 * inch, n), sy - size / 2, n);  // across the horizontal seam only

  // vertical (fake-only), across the first horizontal seam, in the third column
  const vx = (i: number) => xs[2] + inch + i * 0.5 * inch;
  n = charsFor(0.6 * inch); add("v", centred(sy, n), vx(0), n);
  n = charsFor(3 * inch); add("v", centred(sy + 0.3 * inch, n), vx(1), n);
  n = Math.floor(maxLen / adv); add("v", centred(sy, n), vx(2), n);
  {
    // gap cut 0.3·size short of the upper tile's edge: more than 3 render px, less than 0.6·size
    const text = makeText(out.length, charsFor(5 * inch), rnd);
    const k = text.indexOf(" ", Math.floor(text.length / 2));
    out.push({ dir: "v", size, text, c0: vx(3), a0: sy + ov - (k * ADV + 0.25) * size });
  }

  // filler, inside every core
  for (const t of plan.tiles) {
    const cx = (t.core.x0 + t.core.x1) / 2, cy = (t.core.y0 + t.core.y1) / 2;
    n = charsFor(1.2 * inch); add("h", centred(cx + 1.5 * inch, n), cy + 1.5 * inch, n);
    n = charsFor(0.9 * inch); add("h", centred(cx + 1.6 * inch, n), cy + 2 * inch, n);
  }
  return out;
}

const near = (g: Truth, zoom: number) => Math.max(3 / zoom, g.size);

/** Distance from `b` to the nearest inner edge of `render`, or -1 if `b`
 * isn't wholly inside it. Inner edges are the ones not on the plan's rect. */
function clearance(plan: TilePlan, render: Rect, b: Rect): number {
  if (b.x0 < render.x0 || b.y0 < render.y0 || b.x1 > render.x1 || b.y1 > render.y1) return -1;
  const r = plan.rect;
  const d = [
    render.x0 > r.x0 ? b.x0 - render.x0 : Infinity, render.x1 < r.x1 ? render.x1 - b.x1 : Infinity,
    render.y0 > r.y0 ? b.y0 - render.y0 : Infinity, render.y1 < r.y1 ? render.y1 - b.y1 : Infinity,
  ];
  return Math.min(...d);
}

/** A true straddler: no tile holds it clear of every inner edge. */
const isStraddler = (plan: TilePlan, g: Truth) =>
  !plan.tiles.some(t => clearance(plan, t.render, truthBox(g)) >= near(g, plan.zoom));

function runAll(plan: TilePlan, truth: Truth[]) {
  const run = createSeamRun(plan);
  const seen: SeamProgress[] = [run.progress()];
  const jobs: SeamJob[] = [];
  const patched = asPatched(truth);
  for (let job = run.next(); job; job = run.next()) {
    jobs.push(job);
    run.accept(job, fakeRead(job.kind === "tile" ? truth : patched, job.render, job.zoom));
    seen.push(run.progress());
  }
  return { lines: run.lines(), jobs, seen };
}

/** At most ceil(span / maxSide) patches per seam, span the straddlers'
 * extent across it. */
function patchBound(plan: TilePlan, straddlers: Truth[]): number {
  const seams = new Map<string, { lo: number; hi: number }>();
  const cuts = (k: "x0" | "y0") => [...new Set(plan.tiles.map(t => t.core[k]))].filter(v => v > plan.rect[k]);
  for (const g of straddlers) {
    const b = truthBox(g);
    const [lo, hi, a0, a1, at] = g.dir === "h" ? [b.y0, b.y1, b.x0, b.x1, cuts("x0")] : [b.x0, b.x1, b.y0, b.y1, cuts("y0")];
    for (const s of at.filter(s => a0 - plan.overlap < s && s < a1 + plan.overlap)) {
      const key = `${g.dir}${s}`, e = seams.get(key);
      seams.set(key, e ? { lo: Math.min(e.lo, lo), hi: Math.max(e.hi, hi) } : { lo, hi });
    }
  }
  return [...seams.values()].reduce((n, e) => n + Math.ceil((e.hi - e.lo) / plan.maxSide), 0);
}

function assertMatchesTruth(lines: SeamLine[], truth: Truth[], zoom: number, label: string) {
  const tol = 2 / zoom; // 2 render px
  const left = [...lines];
  for (const g of truth) {
    const b = truthBox(g);
    const i = left.findIndex(l => l.str === g.text
      && Math.abs(l.x - b.x0) <= tol && Math.abs(l.x + l.w - b.x1) <= tol
      && Math.abs(l.y - l.h - b.y0) <= tol && Math.abs(l.y - b.y1) <= tol);
    if (i < 0) {
      const same = lines.filter(l => l.str === g.text);
      assert.fail(`${label}: ${g.dir} "${g.text.slice(0, 24)}…" at ${JSON.stringify(b)} not read; `
        + `same text: ${JSON.stringify(same)}; overlapping: ${JSON.stringify(lines.filter(l => l.x < b.x1 && l.x + l.w > b.x0 && l.y - l.h < b.y1 && l.y > b.y0).map(l => l.str.slice(0, 24)))}`);
    }
    left.splice(i, 1);
  }
  assert.deepEqual(left.map(l => l.str), [], `${label}: extra lines`);
  assert.ok(lines.every(l => !l.clipped), `${label}: nothing flagged clipped`);
}

const CONFIGS: [number, number, number][] = [[36, 24, 2], [48, 36, 2], [42, 30, 1.37], [48, 36, 1.37], [36, 24, 1], [48, 36, 1]];

test("the layout is unambiguous: no line sits within 4 render px of the near threshold", () => {
  for (const [w, h, rs] of CONFIGS) {
    const plan = planTiles(pageRect(w, h, rs), rs);
    const truth = layout(plan);
    for (const g of truth) {
      const b = truthBox(g);
      for (const t of plan.tiles) {
        const c = clearance(plan, t.render, b);
        if (c >= 0) assert.ok(Math.abs(c - near(g, plan.zoom)) * plan.zoom > 4, `${w}×${h} rs ${rs}: "${g.text.slice(0, 12)}" in tile ${t.index}`);
      }
      assert.ok(b.x0 - plan.rect.x0 > IN * rs / 2 && plan.rect.x1 - b.x1 > IN * rs / 2 && b.y0 - plan.rect.y0 > IN * rs / 2 && plan.rect.y1 - b.y1 > IN * rs / 2, "clear of the page edge");
    }
    for (let i = 0; i < truth.length; i++) for (let j = i + 1; j < truth.length; j++) {
      const a = truthBox(truth[i]), c = truthBox(truth[j]);
      const overlap = a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
      const pair = j === i + 1 && Math.abs(truth[j].c0 - truth[i].c0 - 0.6 * truth[i].size) < 1e-9; // the one deliberate pair
      assert.ok(!overlap || pair, `${w}×${h} rs ${rs}: lines ${i} and ${j} overlap`);
    }
  }
});

test("tiles, then patches, read every line exactly once: exact text, boxes within 2 render px", () => {
  for (const [w, h, rs] of CONFIGS) {
    const plan = planTiles(pageRect(w, h, rs), rs);
    const truth = layout(plan);
    const { lines, jobs } = runAll(plan, truth);
    const label = `${w}×${h} in rs ${rs}`;
    assertMatchesTruth(lines, expected(truth), plan.zoom, label);
    const straddlers = truth.filter(g => isStraddler(plan, g));
    assert.ok(straddlers.length >= 10, `${label}: the layout has straddlers (${straddlers.length})`);
    const patches = jobs.filter(j => j.kind === "patch");
    assert.ok(patches.length <= patchBound(plan, straddlers), `${label}: ${patches.length} patches for ${straddlers.length} straddlers, bound ${patchBound(plan, straddlers)}`);
    for (const p of patches) {
      assert.ok(straddlers.some(g => { const b = truthBox(g); return b.x0 < p.render.x1 && b.x1 > p.render.x0 && b.y0 < p.render.y1 && b.y1 > p.render.y0; }), `${label}: patch ${p.index} reads a straddler`);
    }
    for (const j of jobs) {
      assert.equal(factorOf(rs, j.render), plan.zoom, `${label}: ${j.kind} ${j.index} factor`);
      const d = dimsOf(j.render, j.zoom);
      assert.ok(d.width <= SCAN_MAX_DIM && d.height <= SCAN_MAX_DIM, `${label}: ${j.kind} ${j.index} ${d.width}×${d.height}`);
    }
  }
});

test("the gap-cut cases really end short of the edge, by more than 3 render px", () => {
  // Guards the fixture: the fake must produce what the near margin is for.
  const plan = planTiles(pageRect(48, 36, 2), 2);
  const truth = layout(plan);
  const v = truth.filter(g => g.dir === "v").at(-1)!;
  const upper = plan.tiles.find(t => t.core.y0 === plan.rect.y0 && inCore(t, v.c0, v.a0 + 1))!;
  const [frag] = fakeRead([v], upper.render, plan.zoom);
  const short = (upper.render.y1 - frag.y) * plan.zoom;
  assert.ok(short > 3 && short < 0.6 * v.size * plan.zoom, `ends ${short} render px short`);
});

test("progress: tiles n/N, then seams n/M; done never decreases or passes total", () => {
  for (const [w, h, rs] of CONFIGS) {
    const plan = planTiles(pageRect(w, h, rs), rs);
    const { jobs, seen } = runAll(plan, layout(plan));
    const patches = jobs.filter(j => j.kind === "patch").length;
    assert.deepEqual(seen[0], { phase: "tiles", done: 0, total: plan.tiles.length, rastersDone: 0, rastersPlanned: plan.tiles.length });
    for (let i = 1; i < seen.length; i++) {
      const [a, b] = [seen[i - 1], seen[i]];
      assert.ok(b.done <= b.total && b.rastersDone <= b.rastersPlanned, JSON.stringify(b));
      assert.ok(!(a.phase === "seams" && b.phase === "tiles"), "phases run tiles → seams");
      if (a.phase === b.phase) assert.ok(b.done >= a.done && b.total === a.total, `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      assert.ok(b.rastersDone > a.rastersDone && b.rastersPlanned >= a.rastersPlanned);
    }
    assert.deepEqual(seen.at(-1), { phase: "seams", done: patches, total: patches, rastersDone: jobs.length, rastersPlanned: jobs.length });
    assert.equal(jobs.length, plan.tiles.length + patches);
  }
});

test("a 30-row table across a seam is read by one patch", () => {
  const rs = 2, plan = planTiles(pageRect(36, 24, rs), rs);
  const sx = plan.tiles[1].core.x0, size = 10 * rs, adv = ADV * size, rnd = mulberry32(30);
  const truth: Truth[] = [];
  for (let i = 0; i < 30; i++) {
    const n = Math.round(((3 + (i % 6)) * IN * rs) / adv);
    truth.push({ dir: "h", size, text: makeText(i, n, rnd), c0: 2 * IN * rs + i * 0.3 * IN * rs, a0: sx - ((1.5 + (i % 3) * 0.5) * IN * rs) });
  }
  assert.equal(truth.filter(g => isStraddler(plan, g)).length, 30);
  const { lines, jobs } = runAll(plan, truth);
  assert.equal(jobs.filter(j => j.kind === "patch").length, 1);
  assertMatchesTruth(lines, truth, plan.zoom, "30 rows");
});

test("rows spanning more than the cap across one seam split into patches that each fit", () => {
  const rs = 1, plan = planTiles(pageRect(36, 24, rs), rs);
  const sx = plan.tiles[1].core.x0, size = 10 * rs, adv = ADV * size, rnd = mulberry32(21);
  const truth: Truth[] = [];
  for (let i = 0; i < 43; i++) {
    const n = Math.round((3 * IN * rs) / adv);
    truth.push({ dir: "h", size, text: makeText(i, n, rnd), c0: (1 + i * 0.5) * IN * rs + 0.37 * size, a0: sx - 1.5 * IN * rs });
  }
  const span = truthBox(truth.at(-1)!).y1 - truthBox(truth[0]).y0;
  assert.ok(span > plan.maxSide, `${span / IN} in across`);
  assert.equal(truth.filter(g => isStraddler(plan, g)).length, truth.length);
  const { lines, jobs } = runAll(plan, truth);
  const patches = jobs.filter(j => j.kind === "patch");
  assert.ok(patches.length >= 2, `${patches.length} patches`);
  for (const p of patches) assert.equal(factorOf(rs, p.render), plan.zoom, `patch ${p.index}: ${JSON.stringify(p.render)}`);
  assertMatchesTruth(lines, truth, plan.zoom, "43 rows");
});

test("a 60-row table across a seam: cells only the patch read are kept, once (#488)", () => {
  // Each row's remarks straddle the seam; the shorter ones have a code cell
  // after them, inside the patch the longer rows size. The tiles read every
  // remark's two pieces, but on two rows not the code cell beside it (as the
  // demo's real read did for rooms 3 and 134). The patch reads those whole.
  const rs = 2, plan = planTiles(pageRect(36, 24, rs), rs);
  const sx = plan.tiles[1].core.x0, size = 10 * rs, adv = ADV * size, inch = IN * rs, rnd = mulberry32(60);
  const truth: Truth[] = [];
  const missed = new Set<Truth>();
  for (let i = 0; i < 60; i++) {
    const c0 = 1.5 * inch + i * 0.25 * inch, len = (2.4 + (i % 3) * 0.8) * inch, n = Math.round(len / adv);
    truth.push({ dir: "h", size, text: makeText(i, n, rnd), c0, a0: sx - 1.2 * inch });
    if (i % 3) continue;
    const code: Truth = { dir: "h", size, text: `C-${i + 1}`, c0, a0: sx - 1.2 * inch + (n + 2) * adv };
    truth.push(code);
    if (i === 18 || i === 42) missed.add(code);
  }
  const tileTruth = truth.filter(g => !missed.has(g));
  const run = createSeamRun(plan);
  const jobs: SeamJob[] = [];
  for (let job = run.next(); job; job = run.next()) {
    jobs.push(job);
    run.accept(job, fakeRead(job.kind === "tile" ? tileTruth : truth, job.render, job.zoom));
  }
  assert.equal(jobs.filter(j => j.kind === "patch").length, 1);
  assertMatchesTruth(run.lines(), truth, plan.zoom, "60 rows, two code cells missed by the tiles");
});

test("jobs carry the plan's dpi and zoom; accept takes only the job outstanding and throws otherwise", () => {
  const plan = twoCols();
  const run = createSeamRun(plan);
  const j0 = run.next()!;
  assert.deepEqual(j0, { kind: "tile", index: 0, render: plan.tiles[0].render, dpi: plan.dpi, zoom: plan.zoom });
  assert.deepEqual(run.next(), j0, "next() names the same job until it's accepted");
  assert.throws(() => run.accept({ ...j0, index: 1 }, []), /not the job outstanding/);
  run.accept(j0, [word("CUT", 800, 300, 1072, 310)]);
  assert.throws(() => run.accept(j0, []), /not the job outstanding/, "a duplicate accept");
  const j1 = run.next()!;
  run.accept(j1, [word("T", 928, 300, 1200, 310)]);
  const p = run.next()!;
  assert.equal(p.kind, "patch");
  assert.throws(() => run.accept(j1, []), /not the job outstanding/, "a late accept");
  assert.throws(() => run.accept({ ...p, kind: "tile" }, []), /not the job outstanding/);
  run.accept(p, [word("CUT", 800, 300, 1200, 310)]);
  assert.equal(run.next(), null);
  assert.throws(() => run.accept(p, []), /not the job outstanding/, "after the end");
  assert.deepEqual(run.lines().map(l => l.str), ["CUT"]);
});

test("a run with no straddlers ends on tiles N/N, and lines() before the end throws", () => {
  const plan = twoCols();
  const run = createSeamRun(plan);
  assert.throws(() => run.lines());
  run.accept(run.next()!, [word("A", 100, 100, 200, 110)]);
  run.accept(run.next()!, []);
  assert.equal(run.next(), null);
  assert.deepEqual(run.progress(), { phase: "tiles", done: 2, total: 2, rastersDone: 2, rastersPlanned: 2 });
  assert.deepEqual(run.lines().map(l => l.str), ["A"]);
});

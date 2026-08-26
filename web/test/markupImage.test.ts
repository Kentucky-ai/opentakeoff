// Pure image-markup geometry tests — markupImage.ts is DOM-free, so it runs
// straight under node (same precedent as geometry.test.ts / svgpath). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imagePlacedBox,
  captureRectToImageGeom,
  resizeImageFromCorner,
  clampImageWidth,
  aspectFromDims,
  pickEmbedFormat,
  imageDrawParams,
  sourceCaption,
  filterCaptures,
} from "../src/lib/markupImage.ts";

// ── imagePlacedBox ──────────────────────────────────────────────────────────
test("imagePlacedBox: width-anchored box (bw=w*sheetW, bh=bw*aspect)", () => {
  assert.deepEqual(imagePlacedBox(0.5, 0.5, 1000), { bw: 500, bh: 250 });
});

test("imagePlacedBox: tall aspect grows height past width (width-anchor divergence from svgPlacedBox)", () => {
  assert.deepEqual(imagePlacedBox(0.25, 2, 800), { bw: 200, bh: 400 });
});

test("imagePlacedBox: degenerate/non-finite inputs → {0,0}", () => {
  assert.deepEqual(imagePlacedBox(0, 0.5, 1000), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(-1, 0.5, 1000), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(0.5, 0, 1000), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(0.5, -1, 1000), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(0.5, 0.5, Infinity), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(0.5, 0.5, NaN), { bw: 0, bh: 0 });
  // non-finite w / aspect must be guarded too (not just > 0) — else Infinity bw/bh
  assert.deepEqual(imagePlacedBox(Infinity, 0.5, 1000), { bw: 0, bh: 0 });
  assert.deepEqual(imagePlacedBox(0.5, Infinity, 1000), { bw: 0, bh: 0 });
});

test("imagePlacedBox: w is clamped to the [0.02, 2] rails (an imported extreme w can't mint a giant box)", () => {
  assert.deepEqual(imagePlacedBox(50, 1, 1000), { bw: 2000, bh: 2000 });     // w clamped 50 → 2
  assert.deepEqual(imagePlacedBox(0.001, 1, 1000), { bw: 20, bh: 20 });      // w clamped 0.001 → 0.02
});

// ── captureRectToImageGeom ──────────────────────────────────────────────────
test("captureRectToImageGeom: rect → {at,w,aspect}", () => {
  const g = captureRectToImageGeom({ x0: 100, y0: 50, x1: 300, y1: 150 }, 1000, 800);
  assert.equal(g.w, 0.2);
  assert.equal(g.aspect, 0.5);
  assert.deepEqual(g.at, [0.2, 0.125]);
});

test("captureRectToImageGeom: corner-order independent (swapped corners → same box)", () => {
  const a = captureRectToImageGeom({ x0: 100, y0: 50, x1: 300, y1: 150 }, 1000, 800);
  const b = captureRectToImageGeom({ x0: 300, y0: 150, x1: 100, y1: 50 }, 1000, 800);
  assert.deepEqual(a, b);
});

test("captureRectToImageGeom: degenerate x0==x1 → {w:0, aspect:0}, no NaN/Infinity", () => {
  const g = captureRectToImageGeom({ x0: 200, y0: 50, x1: 200, y1: 150 }, 1000, 800);
  assert.equal(g.w, 0);
  assert.equal(g.aspect, 0);
  assert.ok(Number.isFinite(g.at[0]) && Number.isFinite(g.at[1]));
});

test("captureRectToImageGeom: sheetW=0 / non-finite guarded (no Infinity)", () => {
  const z = captureRectToImageGeom({ x0: 100, y0: 50, x1: 300, y1: 150 }, 0, 800);
  assert.equal(z.w, 0);
  assert.equal(z.aspect, 0);
  assert.ok(Number.isFinite(z.at[0]) && Number.isFinite(z.at[1]));
  const nf = captureRectToImageGeom({ x0: 100, y0: 50, x1: 300, y1: 150 }, Infinity, 800);
  assert.equal(nf.w, 0);
  assert.ok(Number.isFinite(nf.at[0]) && Number.isFinite(nf.at[1]));
});

test("captureRectToImageGeom: at clamped into [0,1] when rect exceeds bounds", () => {
  const g = captureRectToImageGeom({ x0: -500, y0: -400, x1: 3000, y1: 2400 }, 1000, 800);
  assert.ok(g.at[0] >= 0 && g.at[0] <= 1);
  assert.ok(g.at[1] >= 0 && g.at[1] <= 1);
});

// ── resizeImageFromCorner ───────────────────────────────────────────────────
// Recompute the placed box from {w, at} exactly as the renderer does and return
// its top-left corner (at is center; box is width-anchored).
function topLeftOf(w: number, at: [number, number], aspect: number, sheetW: number, sheetH: number) {
  const { bw, bh } = imagePlacedBox(w, aspect, sheetW);
  return { x: at[0] * sheetW - bw / 2, y: at[1] * sheetH - bh / 2 };
}

test("resizeImageFromCorner: top-left invariant on a normal drag", () => {
  const fixedTL = { x: 100, y: 120 };
  const r = resizeImageFromCorner(fixedTL, { x: 300, y: 500 }, 0.5, 1000, 800);
  const tl = topLeftOf(r.w, r.at, 0.5, 1000, 800);
  assert.ok(Math.abs(tl.x - fixedTL.x) < 1e-9);
  assert.ok(Math.abs(tl.y - fixedTL.y) < 1e-9);
});

test("resizeImageFromCorner: top-left STILL invariant at the max clamp rail (drag far past max)", () => {
  const fixedTL = { x: 100, y: 120 };
  const r = resizeImageFromCorner(fixedTL, { x: 100000, y: 500 }, 0.5, 1000, 800);
  assert.equal(r.w, 2); // clamped to max
  const tl = topLeftOf(r.w, r.at, 0.5, 1000, 800);
  assert.ok(Math.abs(tl.x - fixedTL.x) < 1e-9);
  assert.ok(Math.abs(tl.y - fixedTL.y) < 1e-9);
});

test("resizeImageFromCorner: top-left STILL invariant at the min clamp rail (drag below min)", () => {
  const fixedTL = { x: 100, y: 120 };
  const r = resizeImageFromCorner(fixedTL, { x: 105, y: 500 }, 0.5, 1000, 800);
  assert.equal(r.w, 0.02); // clamped to min
  const tl = topLeftOf(r.w, r.at, 0.5, 1000, 800);
  assert.ok(Math.abs(tl.x - fixedTL.x) < 1e-9);
  assert.ok(Math.abs(tl.y - fixedTL.y) < 1e-9);
});

test("resizeImageFromCorner: aspect preserved (bh/bw == aspect)", () => {
  const r = resizeImageFromCorner({ x: 100, y: 120 }, { x: 400, y: 500 }, 0.75, 1000, 800);
  const { bw, bh } = imagePlacedBox(r.w, 0.75, 1000);
  assert.ok(Math.abs(bh / bw - 0.75) < 1e-9);
});

test("resizeImageFromCorner: non-square sheet (sheetW≠sheetH) — catches width/height normalization swap", () => {
  const fixedTL = { x: 100, y: 100 };
  const r = resizeImageFromCorner(fixedTL, { x: 300, y: 400 }, 0.5, 1000, 500);
  // bw=200 → w=0.2, bh=100 → at=[(100+100)/1000,(100+50)/500]=[0.2,0.3]
  assert.equal(r.w, 0.2);
  assert.deepEqual(r.at, [0.2, 0.3]);
  const tl = topLeftOf(r.w, r.at, 0.5, 1000, 500);
  assert.ok(Math.abs(tl.x - fixedTL.x) < 1e-9);
  assert.ok(Math.abs(tl.y - fixedTL.y) < 1e-9);
});

test("resizeImageFromCorner: degenerate sheet dims / aspect → finite at, no NaN/Infinity", () => {
  for (const [sw, sh, asp] of [[0, 800, 0.5], [1000, 0, 0.5], [1000, 800, 0], [1000, 800, Infinity], [NaN, 800, 0.5]]) {
    const r = resizeImageFromCorner({ x: 100, y: 120 }, { x: 300, y: 500 }, asp, sw, sh);
    assert.ok(Number.isFinite(r.w), `w finite for ${sw},${sh},${asp}`);
    assert.ok(Number.isFinite(r.at[0]) && Number.isFinite(r.at[1]), `at finite for ${sw},${sh},${asp}`);
  }
});

// ── imageDrawParams (rotated-page marked-set placement) ─────────────────────
// Reconstruct where pdf-lib's drawImage would put the three box corners from the
// returned {x,y,width,height,rotateDeg} and assert they land exactly on
// toPage(corner) — proving the placement is correct AND un-mirrored on rotated
// pages. pdf-lib: anchor = bottom-left; height axis is +90° from the width axis.
function drawImageCorners(p: { x: number; y: number; width: number; height: number; rotateDeg: number }) {
  const t = (p.rotateDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return {
    bl: [p.x, p.y],
    br: [p.x + p.width * c, p.y + p.width * s],
    tl: [p.x - p.height * s, p.y + p.height * c],
  };
}
const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

test("imageDrawParams: box corners land on toPage(corner) for plain / 90° / 180° page maps", () => {
  const x0 = 100, y0 = 50, bw = 200, bh = 100;
  const maps: Array<(x: number, y: number) => [number, number]> = [
    (x, y) => [x * 2, 1000 - y * 2],   // plain page: y-flip + uniform scale (rotateDeg 0)
    (x, y) => [y * 2 + 10, x * 2 + 20], // 90°-rotated source page (similarity, orientation-reversing)
    (x, y) => [-x * 2 + 500, y * 2],    // 180°-rotated source page
  ];
  for (const toPage of maps) {
    const p = imageDrawParams(toPage, x0, y0, bw, bh);
    const got = drawImageCorners(p);
    assert.ok(near(got.bl, toPage(x0, y0 + bh)), "bottom-left");
    assert.ok(near(got.br, toPage(x0 + bw, y0 + bh)), "bottom-right");
    assert.ok(near(got.tl, toPage(x0, y0)), "top-left");
  }
});

test("imageDrawParams: plain page is axis-aligned (rotateDeg 0, side lengths = px × scale)", () => {
  const p = imageDrawParams((x, y) => [x * 2, 1000 - y * 2], 100, 50, 200, 100);
  assert.equal(p.rotateDeg, 0);
  assert.equal(p.width, 400);
  assert.equal(p.height, 200);
  assert.deepEqual([p.x, p.y], [200, 700]);
});

// ── clampImageWidth ─────────────────────────────────────────────────────────
test("clampImageWidth: rails + interior + NaN", () => {
  assert.equal(clampImageWidth(0.019), 0.02);
  assert.equal(clampImageWidth(2.001), 2);
  assert.equal(clampImageWidth(0.5), 0.5);
  assert.equal(clampImageWidth(NaN), 0.02);
});

// ── aspectFromDims ──────────────────────────────────────────────────────────
test("aspectFromDims: h/w with guard", () => {
  assert.equal(aspectFromDims(200, 100), 0.5);
  assert.equal(aspectFromDims(0, 100), 1);
  assert.equal(aspectFromDims(-5, 100), 1);
  assert.equal(aspectFromDims(Infinity, 100), 1);
  assert.equal(aspectFromDims(NaN, 100), 1);
});

// ── sourceCaption ────────────────────────────────────────────────────────────
test("sourceCaption: label + page → 'Source: <label> · p.<page>'", () => {
  assert.equal(sourceCaption("AF101", 3), "Source: AF101 · p.3");
});

test("sourceCaption: page not a positive finite integer → page part omitted", () => {
  assert.equal(sourceCaption("AF101", 0), "Source: AF101");
  assert.equal(sourceCaption("AF101", -1), "Source: AF101");
  assert.equal(sourceCaption("AF101", 1.5), "Source: AF101");
  assert.equal(sourceCaption("AF101", NaN), "Source: AF101");
  assert.equal(sourceCaption("AF101", Infinity), "Source: AF101");
  assert.equal(sourceCaption("AF101", undefined as any), "Source: AF101");
});

test("sourceCaption: empty/non-string label → ''", () => {
  assert.equal(sourceCaption("", 3), "");
  assert.equal(sourceCaption(null as any, 3), "");
  assert.equal(sourceCaption(undefined as any, 3), "");
  assert.equal(sourceCaption(42 as any, 3), "");
});

// ── pickEmbedFormat ─────────────────────────────────────────────────────────
test("pickEmbedFormat: jpeg→jpg, png→png, else null", () => {
  assert.equal(pickEmbedFormat("data:image/jpeg;base64,x"), "jpg");
  assert.equal(pickEmbedFormat("data:image/png;base64,x"), "png");
  assert.equal(pickEmbedFormat("data:image/webp;base64,x"), null);
  assert.equal(pickEmbedFormat("data:image/gif;base64,x"), null);
  assert.equal(pickEmbedFormat(""), null);
  assert.equal(pickEmbedFormat("data:image/svg+xml;base64,x"), null);
  // exact media type only — a prefix collision must not read as png/jpeg
  assert.equal(pickEmbedFormat("data:image/jpeg2000;base64,x"), null);
  assert.equal(pickEmbedFormat("data:image/png-evil;base64,x"), null);
  assert.equal(pickEmbedFormat("data:image/png,rawdata"), "png");   // `,` payload form
});

// ── filterCaptures — the Captures panel's GLOBAL list + name search ────────
const M = (type: string, text: string) => ({ type, text });

test("filterCaptures: keeps only image markups, project-wide (not sheet-filtered)", () => {
  const markups = [M("image", "AF101-01"), M("cloud", "not an image"), M("image", "AF102-01")];
  assert.deepEqual(filterCaptures(markups, ""), [markups[0], markups[2]]);
});

test("filterCaptures: empty/whitespace query returns every capture, unfiltered", () => {
  const markups = [M("image", "AF101-01"), M("image", "AF102-01")];
  assert.deepEqual(filterCaptures(markups, ""), markups);
  assert.deepEqual(filterCaptures(markups, "   "), markups);
});

test("filterCaptures: name search is case-insensitive substring over text", () => {
  const markups = [M("image", "AF101-01"), M("image", "Roof Detail")];
  assert.deepEqual(filterCaptures(markups, "roof"), [markups[1]]);
  assert.deepEqual(filterCaptures(markups, "AF101"), [markups[0]]);
});

test("filterCaptures: a query matching nothing → []", () => {
  const markups = [M("image", "AF101-01")];
  assert.deepEqual(filterCaptures(markups, "zzz"), []);
});

test("filterCaptures: no image markups at all → [] regardless of query", () => {
  assert.deepEqual(filterCaptures([M("cloud", "x")], ""), []);
});

test("filterCaptures: a capture with no text never matches a non-empty query, but always survives the unfiltered pass", () => {
  const markups = [{ type: "image" }];
  assert.deepEqual(filterCaptures(markups, ""), markups);
  assert.deepEqual(filterCaptures(markups, "anything"), []);
});

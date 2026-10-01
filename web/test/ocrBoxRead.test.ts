// Import from schedule's box read (lib/ocr/boxRead.ts, #484): the box is read
// as a page read is, tiled at 216 DPI (readRegionText), not as one raster
// capped at SCAN_MAX_DIM. The render and the engine are fakes, as in
// ocrRegionRead.test.ts. Pinned:
//   - a box under the cap is one raster of the box at planTiles' zoom, and
//     its words come back in the frame the old one-raster path gave (image px
//     at rs: the client's words untouched);
//   - a large box is read as planTiles' tiles, with progress;
//   - isCurrent() false once a render lands (the canvas left the sheet):
//     that raster is never read, the read rejects AbortError, and the box
//     read through readBoxOnDevice is "cancelled";
//   - boxTooLarge clips the box to the page first, as readRegionText does;
//   - clipped pieces: one ≥ 90% inside a longer one on its row is a repeat
//     and dropped; pieces that only share a seam's overlap band are kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxReadWords, boxTooLarge, boxWords } from "../src/lib/ocr/boxRead.ts";
import { planTiles, tileCount, type Rect, type SeamLine, type SeamProgress } from "../src/lib/ocr/seams.ts";
import { OCR_MAX_TILES } from "../src/lib/ocr/engineOptions.ts";
import { ocrRenderFactor, type RegionRaster } from "../src/lib/ocr/rasterize.ts";
import type { Rasterize } from "../src/lib/ocr/regionRead.ts";
import type { OcrWord } from "../src/lib/ocr/types.ts";
import { readBoxOnDevice } from "../src/lib/scheduleOcrRead.ts";
import type { OcrSession } from "../src/lib/ocr/session.ts";

const RS = 1.5;
const IN = 72 * RS;

/** A pdf.js page of w × h points. */
const fakePage = (wPt: number, hPt: number) => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: wPt * scale, height: hPt * scale }),
});

/** A render that records its rect and dpi and returns a raster at the zoom
 * rasterizeRegion would use; `onRender` runs as each render lands. */
function fakeRender(onRender?: (i: number) => void) {
  const calls: { rect: Rect; dpi?: number; signal?: AbortSignal }[] = [];
  const rasterize: Rasterize = async (_page, rs, rect, opts) => {
    const i = calls.length;
    calls.push({ rect, dpi: opts.dpi, signal: opts.signal });
    await new Promise((r) => setTimeout(r, 1));
    onRender?.(i);
    const zoom = ocrRenderFactor(rs, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0), { dpi: opts.dpi });
    return { width: 1, height: 1, rgba: new Uint8ClampedArray(4), geometry: { rect, zoom } };
  };
  return { calls, rasterize };
}

/** A client whose reply for each raster is `words(raster)`, counting reads. */
function fakeClient(words: (r: RegionRaster) => OcrWord[] = () => []) {
  let reads = 0;
  return {
    reads: () => reads,
    client: { async recognize(r: RegionRaster) { reads++; return words(r); } },
  };
}

test("a box under the cap: one raster of the box at planTiles' zoom; its words come back as the client gave them", async () => {
  // a box away from the page origin, at rs 1.5, so a frame shift would show
  const page = fakePage(36 * 72, 24 * 72);
  const rect: Rect = { x0: 10 * IN, y0: 3 * IN, x1: 18 * IN, y1: 9 * IN };
  const plan = planTiles(rect, RS);
  assert.equal(plan.tiles.length, 1, "fixture: one tile");
  const r = fakeRender();
  const WORDS: OcrWord[] = [
    { str: "CPT-1", x: 10 * IN + 20, y: 3 * IN + 40, w: 60, h: 14, confidence: 0.97 },
    { str: "CARPET TILE", x: 12 * IN, y: 3 * IN + 40, w: 150, h: 14 },
  ];
  const c = fakeClient(() => WORDS.map((w) => ({ ...w })));
  const words = await boxReadWords(page, RS, rect, () => true, { rasterize: r.rasterize, client: c.client })();
  assert.deepEqual(r.calls.map((x) => [x.rect, x.dpi]), [[rect, 216]]);
  assert.equal(plan.zoom, 216 / (72 * RS));
  // the old path rendered rasterizeRegion(page, rs, rect) at ocrRenderFactor:
  // under the cap that is the same zoom, the same rect, so the same frame
  assert.equal(ocrRenderFactor(RS, rect.x1 - rect.x0, rect.y1 - rect.y0), plan.zoom);
  assert.deepEqual(words, WORDS);
});

test("a large box is read tile by tile at 216 DPI, with progress to the end", async () => {
  // 30 × 20 in at rs 1.5: past one raster's cap at 216 DPI
  const page = fakePage(36 * 72, 24 * 72);
  const rect: Rect = { x0: 2 * IN, y0: 2 * IN, x1: 32 * IN, y1: 22 * IN };
  const plan = planTiles(rect, RS);
  assert.ok(plan.tiles.length > 1, `fixture: several tiles (${plan.tiles.length})`);
  const r = fakeRender();
  const c = fakeClient();
  const progress: SeamProgress[] = [];
  await boxReadWords(page, RS, rect, () => true, { rasterize: r.rasterize, client: c.client })(undefined, (p) => progress.push(p));
  assert.deepEqual(r.calls.map((x) => x.rect), plan.tiles.map((t) => t.render));
  assert.ok(r.calls.every((x) => x.dpi === 216));
  assert.equal(c.reads(), plan.tiles.length);
  const last = progress.at(-1)!;
  assert.deepEqual([last.rastersDone, last.rastersPlanned], [plan.tiles.length, plan.tiles.length]);
  assert.equal(progress[0].rastersDone, 0, "progress from the plan, before any raster");
});

test("the canvas leaves the sheet while a raster renders: it is never read, and the read rejects AbortError", async () => {
  const page = fakePage(36 * 72, 24 * 72);
  const rect: Rect = { x0: 2 * IN, y0: 2 * IN, x1: 32 * IN, y1: 22 * IN };
  let current = true;
  const r = fakeRender((i) => { if (i === 1) current = false; });
  const c = fakeClient();
  const outer = new AbortController();
  await assert.rejects(
    boxReadWords(page, RS, rect, () => current, { rasterize: r.rasterize, client: c.client })(outer.signal),
    (e: Error) => e.name === "AbortError",
  );
  assert.equal(r.calls.length, 2, "nothing rendered after it");
  assert.equal(c.reads(), 1, "the raster that landed after the switch was never read");
  assert.equal(outer.signal.aborted, false, "the caller's own signal is left alone");
});

/** A session like the real one (lib/ocr/session.ts run): the task runs with
 * the caller's signal; its throw is `aborted` only when that signal fired,
 * else `failed`. Counts runs. */
function fakeSession() {
  let runs = 0;
  const session: Pick<OcrSession, "run"> = {
    async run(task, o = {}) {
      runs++;
      if (o.signal?.aborted) return { ok: false, reason: "aborted" };
      try { return { ok: true, value: await task(o.signal) }; }
      catch (error) { return o.signal?.aborted ? { ok: false, reason: "aborted" } : { ok: false, reason: "failed", error }; }
    },
  };
  return { session, runs: () => runs };
}

test("through readBoxOnDevice: a sheet switch during a render is cancelled, never read, never a failure", async () => {
  const page = fakePage(36 * 72, 24 * 72);
  const rect: Rect = { x0: 10 * IN, y0: 3 * IN, x1: 18 * IN, y1: 9 * IN };
  let current = true;
  const r = fakeRender(() => { current = false; });
  const c = fakeClient(() => [{ str: "CPT-1", x: 1, y: 1, w: 1, h: 1 }]);
  const s = fakeSession();
  const reads: unknown[] = [];
  const result = await readBoxOnDevice({
    session: s.session,
    readWords: boxReadWords(page, RS, rect, () => current, { rasterize: r.rasterize, client: c.client }),
    tooLarge: () => boxTooLarge(page, RS, rect),
    read: (spans) => { reads.push(spans); return { rows: [] }; },
    isCurrent: () => current,
    onReading: () => {},
    signal: new AbortController().signal,
    box: { textRuns: 0, pageHasText: false },
  });
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(r.calls.length, 1);
  assert.equal(c.reads(), 0, "recognize never called");
  assert.deepEqual(reads, []);
});

test("boxTooLarge: past OCR_MAX_TILES is too large; a box hanging off the page is judged as clipped to it", () => {
  const page = fakePage(36 * 72, 24 * 72);
  const whole: Rect = { x0: 0, y0: 0, x1: 36 * IN, y1: 24 * IN };
  assert.equal(boxTooLarge(page, RS, whole), false);
  // a box far past the page's edges: unclipped it would take more tiles
  // than the cap; clipped, it's the page
  const over: Rect = { x0: -200 * IN, y0: -200 * IN, x1: 236 * IN, y1: 224 * IN };
  assert.ok(tileCount(over, RS) > OCR_MAX_TILES, "fixture: too many tiles before clipping");
  assert.equal(boxTooLarge(page, RS, over), false);
  // any corner order
  assert.equal(boxTooLarge(page, RS, { x0: over.x1, y0: over.y1, x1: over.x0, y1: over.y0 }), false);
  // a page whose whole is too many tiles
  const huge = fakePage(400 * 72, 300 * 72);
  assert.ok(tileCount({ x0: 0, y0: 0, x1: 400 * IN, y1: 300 * IN }, RS) > OCR_MAX_TILES);
  assert.equal(boxTooLarge(huge, RS, { x0: 0, y0: 0, x1: 400 * IN, y1: 300 * IN }), true);
  // a box wholly off the page reads nothing: not "too large"
  assert.equal(boxTooLarge(page, RS, { x0: 40 * IN, y0: 0, x1: 50 * IN, y1: 5 * IN }), false);
});

// ── clipped pieces ───────────────────────────────────────────────────────────

const clip = (str: string, x: number, w: number, y = 500, h = 20): SeamLine => ({ str, x, y, w, h, clipped: true });

test("boxWords: words lose seams' clipped flag and keep their fields", () => {
  const plain: SeamLine = { str: "CPT-1", x: 1, y: 2, w: 3, h: 4, confidence: 0.9 };
  assert.deepEqual(boxWords([plain, clip("ROOM", 10, 40)]), [plain, { str: "ROOM", x: 10, y: 500, w: 40, h: 20 }]);
  assert.ok(!("clipped" in boxWords([clip("ROOM", 10, 40)])[0]));
});

test("boxWords: a clipped piece at least 90% inside a longer clipped piece on its row is a repeat, and dropped", () => {
  const long = clip("PROVIDE ATTIC STOCK AT ALL", 100, 400);
  // 100 wide, 90 of it inside the long piece
  const repeat = clip("ALL ROO", 410, 100);
  assert.deepEqual(boxWords([long, repeat]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL"]);
  assert.deepEqual(boxWords([repeat, long]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL"], "in either order");
  // 89 of 100 inside: kept
  const kept = clip("ALL ROO", 411, 100);
  assert.deepEqual(boxWords([long, kept]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL", "ALL ROO"]);
});

test("boxWords: pieces from either side of a seam that only share the overlap band are both kept", () => {
  // tile A's piece runs to x 600, tile B's starts at 456: they share the
  // 144 px overlap, and each holds a part of the line the other doesn't
  const left = clip("FINISH SCHEDULE GENERAL", 300, 300);
  const right = clip("GENERAL NOTES APPLY", 456, 260);
  assert.deepEqual(boxWords([left, right]).map((w) => w.str), ["FINISH SCHEDULE GENERAL", "GENERAL NOTES APPLY"]);
});

test("boxWords: the repeat rule needs both pieces clipped and on the same row", () => {
  const long = clip("PROVIDE ATTIC STOCK AT ALL", 100, 400);
  const inside = clip("STOCK", 200, 100);
  // a read line (not clipped) inside a clipped one: kept
  const whole: SeamLine = { str: "STOCK", x: 200, y: 500, w: 100, h: 20 };
  assert.deepEqual(boxWords([long, whole]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL", "STOCK"]);
  // a clipped piece inside a longer read line: kept (only clipped pieces repeat)
  const readLong: SeamLine = { ...long, clipped: undefined };
  delete readLong.clipped;
  assert.deepEqual(boxWords([readLong, inside]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL", "STOCK"]);
  // the row below (its box overlaps less than half the smaller height): kept
  const below = clip("STOCK", 200, 100, 511, 20);
  assert.deepEqual(boxWords([long, below]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL", "STOCK"]);
  // half the height overlapping: the same row, a repeat
  const sameRow = clip("STOCK", 200, 100, 510, 20);
  assert.deepEqual(boxWords([long, sameRow]).map((w) => w.str), ["PROVIDE ATTIC STOCK AT ALL"]);
});

test("boxWords: two equal clipped pieces in the same place keep one", () => {
  const a = clip("ATTIC STOCK", 200, 100);
  assert.deepEqual(boxWords([a, { ...a }]).map((w) => w.str), ["ATTIC STOCK"]);
});

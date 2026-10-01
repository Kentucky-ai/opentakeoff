// readRegionText (#471): a page or a marquee read on-device as tiles, then
// patches across the seams. The render and the engine are injected, so these
// tests drive it with a fake page, a fake rasterize and a fake client whose
// replies arrive late. Pinned: page size from the viewport, one raster at a
// time (the next render never starts before the last read settles), abort
// before each render and each read, a late worker reply after an abort
// changes nothing, progress in two phases that never goes back, and the
// words it returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRegionText, readTooLarge, type RegionReadOptions } from "../src/lib/ocr/regionRead.ts";
import { planTiles, tileCount, type Rect, type SeamProgress } from "../src/lib/ocr/seams.ts";
import { OCR_MAX_TILES } from "../src/lib/ocr/engineOptions.ts";
import { ocrRenderFactor, type RegionRaster } from "../src/lib/ocr/rasterize.ts";
import type { OcrWord } from "../src/lib/ocr/types.ts";

const RS = 2;
const IN = 72 * RS; // image px per inch at RS
const zoomAt = (rs: number) => 216 / (72 * rs);

/** A pdf.js page of w × h points; `rotated` swaps the sides, as a /Rotate 90
 * page's viewport does. */
function fakePage(wPt: number, hPt: number, rotated = false) {
  const scales: number[] = [];
  return {
    scales,
    getViewport({ scale }: { scale: number }) {
      scales.push(scale);
      const [w, h] = rotated ? [hPt, wPt] : [wPt, hPt];
      return { width: w * scale, height: h * scale };
    },
  };
}

const boxOf = (w: OcrWord): Rect => ({ x0: w.x, y0: w.y - w.h, x1: w.x + w.w, y1: w.y });

/** What the engine reads in `render`: every line wholly inside it, and a
 * line cut by its edge as the part inside, its text the whole glyphs there.
 * (The seam rules themselves are pinned against a realistic recognizer in
 * ocrSeams.test.ts; this one only has to make a patch happen.) */
function readIn(truth: OcrWord[], render: Rect): OcrWord[] {
  const out: OcrWord[] = [];
  for (const t of truth) {
    const b = boxOf(t);
    if (b.y0 < render.y0 || b.y1 > render.y1) continue;
    const x0 = Math.max(b.x0, render.x0), x1 = Math.min(b.x1, render.x1);
    if (x1 - x0 < t.h) continue;
    if (x0 === b.x0 && x1 === b.x1) { out.push({ ...t }); continue; }
    const per = t.w / t.str.length;
    const s0 = Math.ceil((x0 - b.x0) / per), s1 = Math.floor((x1 - b.x0) / per);
    if (s1 <= s0) continue;
    // the box runs to the edge (unpad stretches a cut box there), the text
    // stops at the last whole glyph
    out.push({ str: t.str.slice(s0, s1), x: x0, y: t.y, w: x1 - x0, h: t.h });
  }
  return out;
}

const abortError = () => new DOMException("aborted", "AbortError");
const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  opts: RegionReadOptions;
  log: string[];
  /** when the fake worker starts and finishes each read */
  workerLog: string[];
  rasterCalls: { rect: Rect; opts: Record<string, unknown> }[];
  maxInFlight: () => number;
  lateReplies: () => number;
}

/** Fake rasterize and client. `delay(i)` is how long the i-th step (render or
 * read) takes. The client models client.ts: reads run one at a time in a
 * FIFO worker; an abort rejects the caller at once with AbortError, a queued
 * read is dropped, but a read the worker already runs keeps it busy until
 * its (late) reply, which is counted and blocks the next read. */
function harness(truth: OcrWord[], over: {
  delay?: (i: number) => number;
  zoom?: (rs: number, i: number) => number;
  recognizeFails?: number;
  rasterizeIgnoresAbort?: boolean;
  rasterizeThrows?: (i: number) => Error | undefined;
  onRecognize?: (i: number) => void;
  onRasterize?: (i: number) => void;
  /** called right after read i's reply resolves its caller */
  onReply?: (i: number) => void;
} = {}): Harness {
  const log: string[] = [], workerLog: string[] = [];
  const rasterCalls: Harness["rasterCalls"] = [];
  let inFlight = 0, maxInFlight = 0, step = 0, late = 0, reads = 0;
  let workerFree: Promise<void> = Promise.resolve();
  const delay = over.delay ?? (() => 1);
  const enter = () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); };
  const rasterize = async (_page: unknown, rs: number, rect: Rect, opts: { dpi?: number; signal?: AbortSignal }): Promise<RegionRaster> => {
    const i = rasterCalls.length;
    rasterCalls.push({ rect, opts: { ...opts } });
    log.push(`rasterize ${i}`);
    over.onRasterize?.(i);
    const thrown = over.rasterizeThrows?.(i);
    if (thrown) throw thrown;
    enter();
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay(step++));
        if (!over.rasterizeIgnoresAbort) opts.signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
      });
    } finally { inFlight--; }
    // the factor rasterizeRegion itself would use for this rect
    const zoom = over.zoom ? over.zoom(rs, i) : ocrRenderFactor(rs, Math.max(1, Math.abs(rect.x1 - rect.x0)), Math.max(1, Math.abs(rect.y1 - rect.y0)), { dpi: opts.dpi });
    return { width: 1, height: 1, rgba: new Uint8ClampedArray(4), geometry: { rect, zoom } };
  };
  const client = {
    recognize(region: RegionRaster, o: { signal?: AbortSignal } = {}): Promise<OcrWord[]> {
      const i = reads++;
      log.push(`recognize ${i}`);
      over.onRecognize?.(i);
      if (o.signal?.aborted) return Promise.reject(abortError());
      enter();
      return new Promise((resolve, reject) => {
        let settled = false, started = false, dropped = false;
        const prev = workerFree;
        let release!: () => void;
        workerFree = new Promise<void>((r) => { release = r; });
        const onAbort = () => {
          if (settled) return;
          settled = true;
          inFlight--;
          if (!started) dropped = true;
          reject(abortError());
        };
        o.signal?.addEventListener("abort", onAbort, { once: true });
        void prev.then(() => {
          if (dropped) { release(); return; }
          started = true;
          workerLog.push(`start ${i}`);
          setTimeout(() => {
            workerLog.push(`reply ${i}`);
            release();
            if (settled) { late++; log.push(`late reply ${i}`); return; }
            settled = true;
            inFlight--;
            o.signal?.removeEventListener("abort", onAbort);
            if (over.recognizeFails === i) reject(new Error("OCR read failed"));
            else resolve(readIn(truth, region.geometry.rect));
            over.onReply?.(i);
          }, delay(step++));
        });
      });
    },
  };
  return { opts: { rasterize, client }, log, workerLog, rasterCalls, maxInFlight: () => maxInFlight, lateReplies: () => late };
}

// 24 × 18 in at rs 2 is 3456 × 2592 px: four tiles at 216 DPI.
const PAGE_PT: [number, number] = [24 * 72, 18 * 72];
const PAGE_RECT: Rect = { x0: 0, y0: 0, x1: 24 * IN, y1: 18 * IN };
const line = (str: string, x: number, y: number): OcrWord => ({ str, x, y, w: str.length * 20, h: 24 });
// well inside the four cores, away from every seam
const INSIDE = [line("ROOM 101", 200, 300), line("CPT-1", 3000, 400), line("VCT-2", 300, 2300), line("RB-1 BASE", 2900, 2400)];
// crosses the vertical seam (x = 1728) and both tiles' overlap (1584..1872),
// so neither tile reads it whole
const STRADDLER = line("FINISH SCHEDULE GENERAL NOTES APPLY", 1400, 1000);

const sortLines = (ls: OcrWord[]) => ls.map((l) => l.str).sort();

test("reads the whole page tile by tile and returns its lines, rasters and time", async () => {
  const h = harness(INSIDE);
  const page = fakePage(...PAGE_PT);
  const { signal } = new AbortController();
  const r = await readRegionText(page, RS, PAGE_RECT, { ...h.opts, signal });
  const plan = planTiles(PAGE_RECT, RS);
  assert.equal(plan.tiles.length, 4, "fixture: four tiles");
  assert.deepEqual(sortLines(r.lines), sortLines(INSIDE));
  assert.equal(r.rasters, 4);
  assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
  assert.deepEqual(h.rasterCalls.map((c) => c.rect), plan.tiles.map((t) => t.render));
  for (const c of h.rasterCalls) {
    assert.equal(c.opts.dpi, 216);
    assert.equal(c.opts.signal, signal, "the render gets the read's signal");
    assert.equal("png" in c.opts, false, "no PNG in the OCR path");
  }
  assert.deepEqual(page.scales, [RS], "page size from the viewport at rs");
});

test("a line across a seam is read whole from a patch", async () => {
  const h = harness([...INSIDE, STRADDLER]);
  const r = await readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts);
  assert.deepEqual(sortLines(r.lines), sortLines([...INSIDE, STRADDLER]));
  assert.ok(r.rasters > 4, `a patch was read (${r.rasters} rasters)`);
  assert.ok(!r.lines.some((l) => "clipped" in l));
});

test("the page size comes from the viewport: a rotated page clips the rect to its own sides", async () => {
  const h = harness([]);
  const page = fakePage(...PAGE_PT, true); // 18 × 24 in once rotated
  const huge: Rect = { x0: -500, y0: -500, x1: 40 * IN, y1: 40 * IN };
  await readRegionText(page, RS, huge, h.opts);
  const W = 18 * IN, H = 24 * IN;
  const xs = h.rasterCalls.flatMap((c) => [c.rect.x0, c.rect.x1]), ys = h.rasterCalls.flatMap((c) => [c.rect.y0, c.rect.y1]);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), W);
  assert.equal(Math.min(...ys), 0);
  assert.equal(Math.max(...ys), H);
});

test("a rect wholly off the page reads nothing", async () => {
  const h = harness(INSIDE);
  const r = await readRegionText(fakePage(...PAGE_PT), RS, { x0: 30 * IN, y0: 0, x1: 32 * IN, y1: IN }, h.opts);
  assert.deepEqual(r.lines, []);
  assert.equal(r.rasters, 0);
  assert.equal(h.rasterCalls.length, 0);
});

test("strictly sequential: never more than one render or read in flight, with late and uneven replies", async () => {
  const delays = [7, 1, 12, 3, 1, 9, 2, 14, 5, 1, 8, 2, 6, 11, 1, 4];
  const h = harness([...INSIDE, STRADDLER], { delay: (i) => delays[i % delays.length] });
  let rastersAtRead = -1;
  const h2 = harness([...INSIDE, STRADDLER], {
    delay: (i) => delays[i % delays.length],
    onRecognize: () => { rastersAtRead = h2.rasterCalls.length; },
    onRasterize: (i) => { if (i > 0) assert.equal(h2.log.at(-2), `recognize ${i - 1}`, `render ${i} follows read ${i - 1}: ${h2.log.join(", ")}`); },
  });
  await readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts);
  assert.equal(h.maxInFlight(), 1);
  await readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h2.opts);
  assert.ok(rastersAtRead > 0);
  // render, read, render, read … exactly alternating
  h2.log.forEach((e, i) => assert.equal(e.split(" ")[0], i % 2 ? "recognize" : "rasterize", h2.log.join(", ")));
});

test("a failed read rejects the whole read and renders nothing more", async () => {
  const h = harness(INSIDE, { recognizeFails: 1 });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts), /OCR read failed/);
  await later(30);
  assert.equal(h.rasterCalls.length, 2);
});

test("a raster at the wrong zoom is refused before it is read", async () => {
  const h = harness(INSIDE, { zoom: (rs, i) => (i === 1 ? zoomAt(rs) * 0.9 : zoomAt(rs)) });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts), /zoom/);
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0", "rasterize 1"]);
});

test("an already-aborted signal renders nothing", async () => {
  const h = harness(INSIDE);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  assert.deepEqual(h.log, []);
});

test("abort during a render: the render is cancelled and nothing is read", async () => {
  const ac = new AbortController();
  const h = harness(INSIDE, { delay: () => 20, onRasterize: (i) => { if (i === 1) setTimeout(() => ac.abort(), 5); } });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  await later(60);
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0", "rasterize 1"]);
});

test("abort while a render that ignores the signal finishes: its raster is never read", async () => {
  const ac = new AbortController();
  const h = harness(INSIDE, { delay: () => 20, rasterizeIgnoresAbort: true, onRasterize: (i) => { if (i === 1) setTimeout(() => ac.abort(), 5); } });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  await later(60);
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0", "rasterize 1"]);
});

test("abort during a read rejects AbortError; the worker's late reply starts nothing", async () => {
  const ac = new AbortController();
  const h = harness(INSIDE, { delay: () => 20, onRecognize: (i) => { if (i === 1) setTimeout(() => ac.abort(), 5); } });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  assert.equal(h.lateReplies(), 0, "rejected at the abort, before the worker's reply");
  await later(60);
  assert.equal(h.lateReplies(), 1);
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0", "rasterize 1", "recognize 1", "late reply 1"]);
});

test("progress: tiles then seams, never backwards, never past its total, ending at every raster", async () => {
  const seen: SeamProgress[] = [];
  const h = harness([...INSIDE, STRADDLER]);
  const r = await readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, onProgress: (p) => seen.push({ ...p }) });
  assert.ok(seen.length >= r.rasters + 1, "one report up front and one per raster");
  assert.deepEqual(seen[0], { phase: "tiles", done: 0, total: 4, rastersDone: 0, rastersPlanned: 4 });
  const phases = seen.map((p) => p.phase);
  assert.ok(phases.includes("seams"), "the patch phase is reported");
  assert.equal(phases.lastIndexOf("tiles") < phases.indexOf("seams"), true, "tiles, then seams");
  for (let i = 0; i < seen.length; i++) {
    const p = seen[i];
    assert.ok(p.done <= p.total && p.rastersDone <= p.rastersPlanned, JSON.stringify(p));
    if (i > 0) {
      const q = seen[i - 1];
      assert.ok(p.rastersDone >= q.rastersDone, `rasters done went back: ${JSON.stringify(q)} → ${JSON.stringify(p)}`);
      if (p.phase === q.phase) assert.ok(p.done >= q.done, `done went back: ${JSON.stringify(q)} → ${JSON.stringify(p)}`);
    }
  }
  const last = seen.at(-1)!;
  assert.equal(last.rastersDone, r.rasters);
  assert.equal(last.rastersPlanned, r.rasters);
  assert.equal(last.done, last.total);
});

test("abort between rasters (from the progress callback): the next render never starts", async () => {
  const ac = new AbortController();
  const h = harness(INSIDE);
  const onProgress = (p: SeamProgress) => { if (p.rastersDone === 1) ac.abort(); };
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal, onProgress }), (e: Error) => e.name === "AbortError");
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0"]);
});

test("a read started after an abort waits for the worker's late reply, then runs", async () => {
  const ac = new AbortController();
  const h = harness(INSIDE, { delay: () => 20, onRecognize: (i) => { if (i === 1) setTimeout(() => ac.abort(), 5); } });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  const r = await readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts);
  assert.deepEqual(sortLines(r.lines), sortLines(INSIDE));
  const w = h.workerLog;
  assert.ok(w.indexOf("reply 1") < w.indexOf("start 2"), w.join(", "));
});

// one tile: 400 × 300 image px
const SMALL: Rect = { x0: 0, y0: 0, x1: 400, y1: 300 };

test("abort as the last read's reply lands: the read rejects instead of returning", async () => {
  const ac = new AbortController();
  const h = harness([line("A", 50, 100)], { onReply: () => ac.abort() });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, SMALL, { ...h.opts, signal: ac.signal }), (e: Error) => e.name === "AbortError");
  assert.equal(h.rasterCalls.length, 1);
});

test("pdf.js cancelling the render (the document was closed) rejects as AbortError, signal or not", async () => {
  const cancelled = () => Object.assign(new Error("Rendering cancelled, page 3"), { name: "RenderingCancelledException" });
  const h = harness(INSIDE, { rasterizeThrows: (i) => (i === 1 ? cancelled() : undefined) });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts), (e: Error) => e.name === "AbortError" && /closed/.test(e.message));
  assert.deepEqual(h.log, ["rasterize 0", "recognize 0", "rasterize 1"]);
});

test("any other render error is passed through as it is", async () => {
  const h = harness(INSIDE, { rasterizeThrows: () => new Error("no 2d canvas context") });
  await assert.rejects(readRegionText(fakePage(...PAGE_PT), RS, PAGE_RECT, h.opts), (e: Error) => e.name === "Error" && e.message === "no 2d canvas context");
});

// ── the tile cap ─────────────────────────────────────────────────────────────

test("a page past the tile cap is refused before any render", async () => {
  let renders = 0;
  // a render fails at once, so a missing cap fails here rather than hanging
  const rasterize = async () => { renders++; throw new Error("rendered"); };
  await assert.rejects(
    readRegionText(fakePage(200000, 200000), RS, { x0: 0, y0: 0, x1: 200000 * RS, y1: 200000 * RS }, { ...harness([]).opts, rasterize }),
    (e: unknown) => (e as Error).name === "PageTooLargeError",
  );
  assert.equal(renders, 0);
});

test("tileCount matches planTiles, and a 42 × 30 in sheet is well under the cap", () => {
  const sheet: Rect = { x0: 0, y0: 0, x1: 42 * IN, y1: 30 * IN };
  assert.equal(tileCount(sheet, RS), planTiles(sheet, RS).tiles.length);
  assert.equal(tileCount(PAGE_RECT, RS), 4);
  assert.equal(tileCount(sheet, RS), 6);
  assert.ok(tileCount(sheet, RS) <= OCR_MAX_TILES);
  assert.ok(tileCount({ x0: 0, y0: 0, x1: 200000 * RS, y1: 200000 * RS }, RS) > OCR_MAX_TILES);
});

test("readTooLarge: 64 tiles is allowed, 65 is refused", () => {
  const plan = planTiles(PAGE_RECT, RS);
  const core = plan.maxSide - 2 * plan.overlap;
  // n − ½ cores long cuts into n tiles along that side
  const strip = (cols: number, rows: number): Rect => ({ x0: 0, y0: 0, x1: (cols - 0.5) * core, y1: (rows - 0.5) * core });
  assert.equal(tileCount(strip(32, 2), RS), 64);
  assert.equal(readTooLarge(strip(32, 2), RS), false);
  assert.equal(tileCount(strip(65, 1), RS), 65);
  assert.equal(readTooLarge(strip(65, 1), RS), true);
});

test("readTooLarge: a size that isn't a finite positive number is never read", () => {
  for (const r of [{ x0: 0, y0: 0, x1: NaN, y1: 100 }, { x0: 0, y0: 0, x1: Infinity, y1: 100 }, { x0: 0, y0: 0, x1: 0, y1: 100 }, { x0: 0, y0: NaN, x1: 100, y1: 100 }]) {
    assert.equal(readTooLarge(r, RS), true, JSON.stringify(r));
  }
  assert.equal(readTooLarge(PAGE_RECT, NaN), true, "nor a render scale that isn't one");
});

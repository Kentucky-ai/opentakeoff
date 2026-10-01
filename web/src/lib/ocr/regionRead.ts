// Read a page, or a region of it, on-device (#471): tiles at 216 DPI, then
// patches across the seams (seams.ts plans the rasters and joins the lines).
//
// One raster at a time: the next render starts only once the last read has
// settled, so at most one large raster is alive and the worker's FIFO never
// holds a backlog this read would have to wait out on cancel. Abort is
// checked before each render and each read; the render takes the signal and
// cancels its pdf.js task, and a read the worker is already running rejects
// AbortError at once (the client drops the worker's late reply). A read
// started after an abort queues behind that reply (client.ts), which is why
// the UI says "Stopping…" until it lands.
//
// The render and the engine are injected (tests pass fakes); the defaults are
// rasterizeRegion and the app's one OCR client. Importing this touches no DOM
// and starts no worker.
import { rasterizeRegion, type RegionRaster } from "./rasterize";
import { createSeamRun, planTiles, tileCount, type Rect, type SeamLine, type SeamProgress } from "./seams";
import { getOcrClient } from "./client";
import { OCR_MAX_TILES } from "./engineOptions";
import type { OcrWord } from "./types";

/** The pdf.js page surface the read itself uses; `rasterize` needs more. */
export interface PageLike {
  getViewport(o: { scale: number }): { width: number; height: number };
}

export type Rasterize = (
  page: never,
  rs: number,
  rect: Rect,
  opts: { dpi: number; signal?: AbortSignal },
) => Promise<RegionRaster>;

export interface Recognizer {
  recognize(region: RegionRaster, opts?: { signal?: AbortSignal }): Promise<OcrWord[]>;
}

export interface RegionReadOptions {
  signal?: AbortSignal;
  /** after planning and after every raster read; see SeamProgress */
  onProgress?: (p: SeamProgress) => void;
  rasterize?: Rasterize;
  client?: Recognizer;
}

export interface RegionReadResult {
  /** image px at `rs`; `clipped` marks a piece of a line no raster held whole */
  lines: SeamLine[];
  /** wall time of the read */
  ms: number;
  /** rasters read: tiles plus patches */
  rasters: number;
}

const abortError = () => new DOMException("The OCR read was cancelled.", "AbortError");
/** An AbortError whose own signal wasn't aborted: the page went away. */
const pageClosed = () => new DOMException("The page was closed during the read.", "AbortError");
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** A read that would take more than OCR_MAX_TILES tiles, or whose size
 * isn't a finite positive number (a NaN count would pass the cap). */
export function readTooLarge(rect: Rect, rs: number): boolean {
  const w = Math.abs(rect.x1 - rect.x0), h = Math.abs(rect.y1 - rect.y0);
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) && rs > 0 && Number.isFinite(rs))) return true;
  return tileCount(rect, rs) > OCR_MAX_TILES;
}
const tooLargeError = () => Object.assign(new Error(`more than ${OCR_MAX_TILES} tiles`), { name: "PageTooLargeError" });

/** Read the text in `rect` (image px at render scale `rs`, any corner order)
 * of `page`, clipped to the page as its viewport at `rs` gives it (so a
 * rotated page's own sides). Rejects AbortError on abort, and also when
 * pdf.js cancels a render because the document was destroyed (the signal
 * then isn't aborted); PageTooLargeError past OCR_MAX_TILES, before any
 * render; otherwise the first render or read error. */
export async function readRegionText(page: PageLike, rs: number, rect: Rect, opts: RegionReadOptions = {}): Promise<RegionReadResult> {
  const { signal, onProgress } = opts;
  const rasterize = opts.rasterize ?? (rasterizeRegion as unknown as Rasterize);
  const client: Recognizer = opts.client ?? getOcrClient();
  const t0 = performance.now();
  checkAbort(signal);
  const vp = page.getViewport({ scale: rs });
  const r = {
    x0: Math.max(0, Math.min(rect.x0, rect.x1)), y0: Math.max(0, Math.min(rect.y0, rect.y1)),
    x1: Math.min(vp.width, Math.max(rect.x0, rect.x1)), y1: Math.min(vp.height, Math.max(rect.y0, rect.y1)),
  };
  if (!(r.x1 > r.x0 && r.y1 > r.y0)) return { lines: [], ms: performance.now() - t0, rasters: 0 };
  if (readTooLarge(r, rs)) throw tooLargeError();
  const run = createSeamRun(planTiles(r, rs));
  onProgress?.(run.progress());
  let rasters = 0;
  for (let job = run.next(); job; job = run.next()) {
    checkAbort(signal);
    let raster: RegionRaster;
    try {
      raster = await rasterize(page as never, rs, job.render, { dpi: job.dpi, signal });
    } catch (err) {
      // pdf.js cancels the render itself when the document is destroyed
      // mid-read (the canvas closed the file): not an error, a stop.
      if ((err as { name?: string } | null)?.name === "RenderingCancelledException") throw pageClosed();
      throw err;
    }
    if (raster.geometry.zoom !== job.zoom) {
      throw new Error(`${job.kind} ${job.index} rendered at zoom ${raster.geometry.zoom}, planned ${job.zoom}`);
    }
    checkAbort(signal);
    const words = await client.recognize(raster, { signal });
    checkAbort(signal);
    run.accept(job, words);
    rasters++;
    onProgress?.(run.progress());
  }
  return { lines: run.lines(), ms: performance.now() - t0, rasters };
}

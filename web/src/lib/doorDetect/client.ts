// "Find more doors" from the main thread: start the detector worker, hand it
// a page's tiles, and run the fusion pipeline on what comes back.
//
// Everything runs in the browser. The only network request is the one-time
// model download from Hugging Face (the worker caches it); a plan never
// leaves the machine. WebGPU is required: on a browser without it the suite
// carries on with the linework reader alone, because the same model on
// WebAssembly takes close to a minute per sheet.
import type { ReadDoor } from "../doorReader.ts";
import type { OpList, OpsTable } from "../oneclick.ts";
import { applyPipeline, type FoundDoors } from "./apply.ts";
import { legendLabels, restroomWords } from "./filters2.ts";
import type { Box, DetBox, Pt } from "./geom.ts";
import { extractWallSegs, inkMask, pageText, type PdfTextItem } from "./pageInputs.ts";
import { DOOR_DETECT_SETTINGS, runDoorPipeline, type DoorDetectSettings, type PipelineResult } from "./pipeline.ts";
import { clipMask, clipRect, fitSwing, FIT_PXF } from "./swingfit.ts";
import { cutTile, mergeBoxes, tileOrigins, toPagePoints } from "./tiles.ts";
import { CACHE_KEY, cacheNameFor } from "./workerCore.ts";

/** The slice of a pdf.js page this module uses. */
export interface PdfPageLike {
  getViewport(o: { scale: number; rotation: number }): { width: number; height: number; transform: number[] };
  render(p: { canvasContext: CanvasRenderingContext2D; viewport: unknown; transform?: number[]; background?: string }): { promise: Promise<void> };
  getOperatorList(): Promise<OpList>;
  getTextContent(): Promise<{ items: unknown[] }>;
}

interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export class DoorDetectError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** True when this browser can give a WebGPU adapter. */
export async function webGpuAvailable(): Promise<boolean> {
  const gpu = (globalThis.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) return false;
  try { return !!(await gpu.requestAdapter()); } catch { return false; }
}

/** True when the model is already in this browser's cache (no download needed). */
export async function modelCached(S: DoorDetectSettings = DOOR_DETECT_SETTINGS): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const c = await caches.open(cacheNameFor(S.model.sha256));
    return !!(await c.match(CACHE_KEY));
  } catch { return false; }
}

/** Delete the downloaded model from this browser. */
export async function forgetModel(S: DoorDetectSettings = DOOR_DETECT_SETTINGS): Promise<void> {
  try { if (typeof caches !== "undefined") await caches.delete(cacheNameFor(S.model.sha256)); } catch { /* nothing to delete */ }
}

export interface LoadProgress { loaded: number; total: number }

/** One detector worker: load the model once, then detect page after page. */
export class DoorDetectClient {
  private worker: WorkerLike | null = null;
  private loading: Promise<{ cached: boolean }> | null = null;
  private onProgress: ((p: LoadProgress) => void) | null = null;
  private pending = new Map<number, { resolve: (b: DetBox[]) => void; reject: (e: Error) => void }>();
  private settle: { resolve: (v: { cached: boolean }) => void; reject: (e: Error) => void } | null = null;
  private seq = 0;

  constructor(private S: DoorDetectSettings = DOOR_DETECT_SETTINGS, private makeWorker: () => WorkerLike = () => new Worker(new URL("../../doorDetect.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike) {}

  private start(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.makeWorker();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; boxes?: DetBox[]; cached?: boolean; code?: string; message?: string; loaded?: number; total?: number };
      if (m.type === "progress") this.onProgress?.({ loaded: m.loaded ?? 0, total: m.total ?? 0 });
      else if (m.type === "ready") { this.settle?.resolve({ cached: !!m.cached }); this.settle = null; }
      else if (m.type === "boxes" && m.id !== undefined) { this.pending.get(m.id)?.resolve(m.boxes ?? []); this.pending.delete(m.id); }
      else if (m.type === "error") {
        const err = new DoorDetectError(m.code ?? "error", m.message ?? "the door detector failed");
        if (m.id !== undefined) { this.pending.get(m.id)?.reject(err); this.pending.delete(m.id); }
        else { this.settle?.reject(err); this.settle = null; }
      }
    };
    w.onerror = (e) => {
      const err = new DoorDetectError("worker", e.message || "the door detector worker stopped");
      this.settle?.reject(err); this.settle = null;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }

  /** Load the model. With allowNetwork false it only succeeds from the cache (code "consent-required" otherwise). */
  load(allowNetwork: boolean, onProgress?: (p: LoadProgress) => void): Promise<{ cached: boolean }> {
    if (this.loading) { if (onProgress) this.onProgress = onProgress; return this.loading; }
    this.onProgress = onProgress ?? null;
    const w = this.start();
    this.loading = new Promise<{ cached: boolean }>((resolve, reject) => { this.settle = { resolve, reject }; w.postMessage({ type: "init", allowNetwork }); });
    // a failed load can be tried again (the person may allow the download next time)
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  cancel(): void { this.worker?.postMessage({ type: "cancel" }); }

  /** Run the model over a gray page render (z = pixels per page point). Boxes come back in page points. */
  async detect(gray: Uint8Array, w: number, h: number, z: number, onTile?: (done: number, total: number) => void): Promise<{ boxes: DetBox[]; tiles: number }> {
    const D = this.S.detect, worker = this.start();
    const jobs: Array<[number, number, Uint8Array]> = [];
    for (const [x, y] of tileOrigins(w, h, D.tile, D.stride)) {
      const t = cutTile(gray, w, h, x, y, D.tile, D.blank_min);
      if (!t.blank) jobs.push([x, y, t.px]);
    }
    const all: DetBox[] = [];
    let done = 0;
    for (const [x, y, px] of jobs) {
      const id = ++this.seq;
      const boxes = await new Promise<DetBox[]>((resolve, reject) => { this.pending.set(id, { resolve, reject }); worker.postMessage({ type: "tile", id, px, x, y }, [px.buffer]); });
      for (const b of boxes) all.push(b);
      onTile?.(++done, jobs.length);
    }
    return { boxes: toPagePoints(mergeBoxes(all, D.merge_overlap, D.strip_separate), z), tiles: jobs.length };
  }

  dispose(): void {
    this.worker?.postMessage({ type: "dispose" });
    this.worker?.terminate();
    this.worker = null; this.loading = null; this.settle = null;
    for (const p of this.pending.values()) p.reject(new DoorDetectError("aborted", "the door detector was closed"));
    this.pending.clear();
  }
}

const MAX_BAND_PX = 12e6;

/**
 * A page, or a rectangle of it (page points, unrotated frame), as 8-bit gray
 * at z pixels per point, white paper. Rendered in bands so a large sheet
 * never needs one huge canvas. Returns the pixel offset of the rectangle too.
 */
export async function renderGray(page: PdfPageLike, z: number, rect?: Box): Promise<{ gray: Uint8Array; w: number; h: number; x0: number; y0: number }> {
  const vp = page.getViewport({ scale: z, rotation: 0 });
  const x0 = rect ? Math.floor(rect[0] * z) : 0, y0 = rect ? Math.floor(rect[1] * z) : 0;
  const w = Math.max(1, rect ? Math.ceil(rect[2] * z) - x0 : Math.round(vp.width)), h = Math.max(1, rect ? Math.ceil(rect[3] * z) - y0 : Math.round(vp.height));
  const gray = new Uint8Array(w * h);
  const band = Math.max(64, Math.min(h, Math.floor(MAX_BAND_PX / w)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  for (let y = 0; y < h; y += band) {
    const bh = Math.min(band, h - y);
    canvas.height = bh;   // also clears it
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new DoorDetectError("render", "no 2d canvas for the page render");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, bh);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -(y0 + y)], background: "#fff" }).promise;
    const px = ctx.getImageData(0, 0, w, bh).data;
    for (let i = 0, o = y * w; i < px.length; i += 4, o++) gray[o] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29 + 128) >> 8;
  }
  canvas.width = canvas.height = 0;
  return { gray, w, h, x0, y0 };
}

export interface FindProgress { stage: "render" | "detect" | "fuse"; done?: number; total?: number }
export interface FindResult extends FoundDoors {
  /** detector boxes, page points */
  det: DetBox[];
  tiles: number;
  /** seconds: page render, model, fusion */
  seconds: { render: number; detect: number; fuse: number };
  result: PipelineResult;
}

/**
 * The whole pass for one sheet. `doors` are the reader's doors for the page,
 * `fpp` the feet per page point they were read at (the detector needs the
 * sheet's scale: it was trained at 20 pixels per foot).
 */
export async function findMoreDoors(
  page: PdfPageLike, doors: ReadDoor[], fpp: number, OPS: OpsTable, client: DoorDetectClient,
  onProgress?: (p: FindProgress) => void, S: DoorDetectSettings = DOOR_DETECT_SETTINGS,
): Promise<FindResult> {
  if (!(fpp > 0)) throw new DoorDetectError("no-scale", "the sheet's scale is not known");
  const ppf = 1 / fpp, z = S.detect.px_per_ft / ppf;
  const t0 = performance.now();
  onProgress?.({ stage: "render" });
  const { gray, w, h } = await renderGray(page, z);
  const t1 = performance.now();
  const { boxes: det, tiles } = await client.detect(gray, w, h, z, (done, total) => onProgress?.({ stage: "detect", done, total }));
  const t2 = performance.now();
  onProgress?.({ stage: "fuse" });
  const vp0 = page.getViewport({ scale: 1, rotation: 0 });
  const [ol, tc] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
  const { lines, words } = pageText(tc.items as PdfTextItem[], vp0.transform);
  const zc = FIT_PXF / ppf;
  const result = await runDoorPipeline(doors, det, {
    ppf, ink: inkMask(gray, w, h, z, 150), inkPxf: S.detect.px_per_ft, wallInk: inkMask(gray, w, h, z, 160),
    fitSwing: async (b) => {
      const r = clipRect(b, ppf, vp0.width, vp0.height);
      const c = await renderGray(page, zc, r);
      return fitSwing(b, clipMask(c.gray, c.w, c.h, zc), [c.x0 / zc, c.y0 / zc] as Pt, ppf);
    },
    lines, rest: restroomWords(words), labels: legendLabels(lines), segs: extractWallSegs(ol, vp0.transform, OPS),
  }, S);
  const t3 = performance.now();
  return { ...applyPipeline(doors, result, S.model.classes, ppf), det, tiles, result, seconds: { render: (t1 - t0) / 1000, detect: (t2 - t1) / 1000, fuse: (t3 - t2) / 1000 } };
}

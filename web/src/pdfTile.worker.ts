// Tile-render worker (#86) — owns one pdf.js instance PER SHEET PER WORKER,
// renders requested tiles into an OffscreenCanvas, transfers the result back
// as an ImageBitmap (zero-copy). Every open sheet is loaded into EVERY
// worker in the pool (lib/tilePool.ts broadcasts, doesn't hash-pin), and
// tile requests round-robin across the whole pool — so a single sheet gets
// real N-way render parallelism (N = pool size), not just group-mode panels
// splitting across workers.
//
// hush.ts (mcp/) is prior art for "pdf.js is fussy about its environment":
// verbosity:0 here for the same reason (its console noise has no wire
// contract to protect in a Worker, but it's still noise); Promise.withResolvers
// gets the same defensive polyfill pdf.js 4.x needs on any global scope predating
// it (Baseline 2024 — some browsers in the field are still older). Unlike
// mcp/src/pdf.ts, no @napi-rs/canvas shim is needed: OffscreenCanvas + Path2D +
// DOMMatrix + ImageData are all native in a real browser Worker.
//
// GlobalWorkerOptions.workerSrc IS set below, to the same pdf.worker.min.mjs
// the main thread uses — turns out pdf.js 4.x does NOT silently fall back to
// in-context ("fake worker") parsing when it's unset; PDFWorker._initialize
// reads the `workerSrc` getter before any try/catch can catch it, so the
// first getDocument() call in a fresh realm just throws `No
// "GlobalWorkerOptions.workerSrc" specified.` (confirmed live — there's no
// `disableWorker` option on this version's DocumentInitParameters either).
// So: yes, this nests a worker inside a worker for the parse step. That's a
// real extra thread hop, but it's still off the main UI thread, which is the
// only thing that actually matters here — parsing was never going to be the
// expensive part; painting (this worker's own job) is.
//
// Protocol:
//   in : { type:"openSheet", sheetKey, file, pageNum, data: ArrayBuffer }
//        { type:"renderTile", reqId, sheetKey, scale, rect:{x,y,w,h}, dark }
//        { type:"cancel", reqId }
//        { type:"closeSheet", sheetKey }
//   out: { type:"sheetReady", sheetKey } | { type:"sheetError", sheetKey, message }
//        { type:"tile", reqId, sheetKey, bitmap: ImageBitmap, w, h }
//        { type:"tileError", reqId, sheetKey, message }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (Promise as any).withResolvers !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Promise as any).withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// pdf.js's default DOMCanvasFactory allocates SCRATCH canvases during
// page.render() (pattern tiles, transparency groups, image masks) via
// document.createElement — and there is no `document` in a Worker, so every
// render dies with "Cannot read properties of undefined (reading
// 'createElement')" (confirmed live; the doc OPENS fine, only render crashes).
// getDocument() takes the factory CLASS (constructed internally with
// { ownerDocument, enableHWA }) — this one is OffscreenCanvas all the way down.
class OffscreenCanvasFactory {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts?: unknown) { /* ownerDocument/enableHWA — irrelevant off-DOM */ }
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(cc: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    cc.canvas.width = width; cc.canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    cc.canvas.width = 0; cc.canvas.height = 0;
    cc.canvas = null; cc.context = null;
  }
}

// Same story for the default DOMFilterFactory (SVG filter elements need a
// document). pdf.js's own Node build ships `class NodeFilterFactory extends
// BaseFilterFactory {}` — every method returns "none", filters degrade
// gracefully — so a no-op factory here is exactly the upstream-sanctioned
// behavior for a DOM-less realm, not a hack.
class WorkerFilterFactory {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts?: unknown) { /* docId/ownerDocument — unused */ }
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  destroy() { /* nothing cached */ }
}

interface SheetEntry {
  ready: Promise<unknown>; // resolves to the pdf.js page object
  chain: Promise<void>;    // serializes renders on this sheet's page
}

const sheets = new Map<string, SheetEntry>();
const inflight = new Map<number, { cancelled: boolean; task?: { cancel: () => void } }>();

// tsconfig's `lib` is DOM-only (no "webworker" — TS disallows DOM + webworker
// together in one program, and this repo's app code needs DOM). That makes
// `self` type as `Window`, whose postMessage(message, targetOrigin, transfer)
// overload doesn't match a transfer-list call — this worker is the first in
// the repo to transfer (stt.worker.ts never does). One narrow cast, isolated
// here, instead of fighting the project-wide lib config.
const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

function invertOffscreen(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

type InMsg =
  | { type: "openSheet"; sheetKey: string; pageNum: number; data: ArrayBuffer }
  | { type: "renderTile"; reqId: number; sheetKey: string; scale: number; rect: { x: number; y: number; w: number; h: number }; dark: boolean }
  | { type: "cancel"; reqId: number }
  | { type: "closeSheet"; sheetKey: string };

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "openSheet") {
    if (sheets.has(msg.sheetKey)) return; // idempotent — same file, already opening/open
    const ready = (async () => {
      // workerSrc is set above (see header) — the parse step runs in a nested
      // worker. CanvasFactory/FilterFactory MUST be overridden here: the DOM
      // defaults dereference `document` mid-render (see class comments above).
      const task = pdfjsLib.getDocument({
        data: msg.data,
        verbosity: 0,
        CanvasFactory: OffscreenCanvasFactory,
        FilterFactory: WorkerFilterFactory,
        // FontLoader gates ALL embedded-font binding on `ownerDocument.fonts`
        // (default ownerDocument = globalThis.document = undefined here), so
        // without this every glyph paints as a .notdef tofu box (confirmed
        // live at 102% zoom). Workers have their own FontFaceSet — self.fonts
        // — and OffscreenCanvas text drawing reads from it, so handing pdf.js
        // the worker global as its "document" makes embedded fonts load
        // exactly like they do on the main thread. (FontLoader's DOM-y
        // createElement/styleSheet path is only reached when FontFaceSet is
        // MISSING, so it stays dead here.)
        ownerDocument: self as unknown as Document,
      });
      const doc = await task.promise;
      const page = await doc.getPage(msg.pageNum);
      return page;
    })();
    sheets.set(msg.sheetKey, { ready, chain: Promise.resolve() });
    ready.then(
      () => post({ type: "sheetReady", sheetKey: msg.sheetKey }),
      (err) => { sheets.delete(msg.sheetKey); post({ type: "sheetError", sheetKey: msg.sheetKey, message: String(err?.message || err) }); },
    );
    return;
  }

  if (msg.type === "closeSheet") {
    sheets.delete(msg.sheetKey);
    return;
  }

  if (msg.type === "cancel") {
    const f = inflight.get(msg.reqId);
    if (f) { f.cancelled = true; try { f.task?.cancel(); } catch { /* already done */ } }
    return;
  }

  if (msg.type === "renderTile") {
    const { reqId, sheetKey, scale, rect, dark } = msg;
    const entry = sheets.get(sheetKey);
    const flag = { cancelled: false } as { cancelled: boolean; task?: { cancel: () => void } };
    inflight.set(reqId, flag);
    if (!entry) {
      inflight.delete(reqId);
      post({ type: "tileError", reqId, sheetKey, message: "sheet not open" });
      return;
    }
    entry.chain = entry.chain.then(async () => {
      if (flag.cancelled) { inflight.delete(reqId); return; }
      try {
        const page = await entry.ready;
        if (flag.cancelled) { inflight.delete(reqId); return; }
        const canvas = new OffscreenCanvas(Math.max(1, rect.w), Math.max(1, rect.h));
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const viewport = (page as any).getViewport({ scale });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const renderTask = (page as any).render({
          canvasContext: ctx,
          viewport,
          transform: [1, 0, 0, 1, -rect.x, -rect.y],
        });
        flag.task = renderTask;
        await renderTask.promise;
        if (flag.cancelled) { inflight.delete(reqId); return; }
        if (dark) invertOffscreen(canvas);
        const bitmap = canvas.transferToImageBitmap();
        inflight.delete(reqId);
        post({ type: "tile", reqId, sheetKey, w: rect.w, h: rect.h, bitmap }, [bitmap]);
      } catch (err) {
        inflight.delete(reqId);
        // RenderingCancelledException on supersede/cancel is expected, not an error
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.name === "RenderingCancelledException" || flag.cancelled) return;
        post({ type: "tileError", reqId, sheetKey, message: String((err as Error)?.message || err) });
      }
    });
  }
};

// Main-thread client for a small pool of pdfTile.worker.ts instances (#86).
// Mirrors voiceRecognizerClient.ts's lazy-worker-lifecycle pattern. A sheet's
// pdf.js Document/Page state lives in exactly one worker (render tasks on the
// same page can't overlap), chosen by hashing the sheet key across the pool —
// so DIFFERENT panels in a sheet group land on DIFFERENT workers and render
// in parallel, which is the whole point of a POOL rather than one worker.

export interface TileRequest {
  sheetKey: string;
  scale: number;               // pdf.js render scale (RENDER_SCALE * density)
  rect: { x: number; y: number; w: number; h: number }; // level px
  dark: boolean;
}

export interface TileResult { w: number; h: number; bitmap: ImageBitmap; }

type OutMsg =
  | { type: "sheetReady"; sheetKey: string }
  | { type: "sheetError"; sheetKey: string; message: string }
  | { type: "tile"; reqId: number; sheetKey: string; w: number; h: number; bitmap: ImageBitmap }
  | { type: "tileError"; reqId: number; sheetKey: string; message: string };

const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1 || 2));

function hashKey(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function createTilePool(size = POOL_SIZE) {
  const workers: Worker[] = [];
  const sheetWorker = new Map<string, number>();
  const sheetReady = new Map<string, { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> }>();
  const pending = new Map<number, { resolve: (r: TileResult) => void; reject: (e: Error) => void }>();
  let nextReqId = 1;
  let disposed = false;

  function ensureWorker(i: number): Worker {
    if (!workers[i]) {
      const w = new Worker(new URL("../pdfTile.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<OutMsg>) => onMessage(e.data);
      workers[i] = w;
    }
    return workers[i];
  }

  function onMessage(m: OutMsg) {
    if (m.type === "sheetReady") { sheetReady.get(m.sheetKey)?.resolve(); return; }
    if (m.type === "sheetError") { sheetReady.get(m.sheetKey)?.reject(new Error(m.message)); return; }
    if (m.type === "tile") { pending.get(m.reqId)?.resolve({ w: m.w, h: m.h, bitmap: m.bitmap }); pending.delete(m.reqId); return; }
    if (m.type === "tileError") { pending.get(m.reqId)?.reject(new Error(m.message)); pending.delete(m.reqId); return; }
  }

  function workerFor(sheetKey: string): { w: Worker; idx: number } {
    let idx = sheetWorker.get(sheetKey);
    if (idx == null) { idx = hashKey(sheetKey) % size; sheetWorker.set(sheetKey, idx); }
    return { w: ensureWorker(idx), idx };
  }

  /** Idempotent — calling twice for the same sheetKey is a no-op after the
   *  first. `data` is TRANSFERRED (the caller must pass a fresh copy, not a
   *  buffer still owned by the main-thread pdf.js instance). */
  function openSheet(sheetKey: string, pageNum: number, data: ArrayBuffer): Promise<void> {
    if (disposed) return Promise.reject(new Error("tile pool disposed"));
    let entry = sheetReady.get(sheetKey);
    if (entry) return entry.promise;
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    entry = { resolve, reject, promise };
    sheetReady.set(sheetKey, entry);
    const { w } = workerFor(sheetKey);
    w.postMessage({ type: "openSheet", sheetKey, pageNum, data }, [data]);
    return promise;
  }

  function requestTile(req: TileRequest): { promise: Promise<TileResult>; reqId: number; cancel: () => void } {
    const reqId = nextReqId++;
    const { w } = workerFor(req.sheetKey);
    const promise = new Promise<TileResult>((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      w.postMessage({ type: "renderTile", reqId, sheetKey: req.sheetKey, scale: req.scale, rect: req.rect, dark: req.dark });
    });
    const cancel = () => { pending.delete(reqId); w.postMessage({ type: "cancel", reqId }); };
    return { promise, reqId, cancel };
  }

  function closeSheet(sheetKey: string) {
    const { w } = workerFor(sheetKey);
    w.postMessage({ type: "closeSheet", sheetKey });
    sheetWorker.delete(sheetKey);
    sheetReady.delete(sheetKey);
  }

  function dispose() {
    disposed = true;
    for (const w of workers) w?.terminate();
    workers.length = 0;
    sheetWorker.clear(); sheetReady.clear(); pending.clear();
  }

  return { openSheet, requestTile, closeSheet, dispose };
}
